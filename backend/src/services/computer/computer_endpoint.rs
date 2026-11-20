//! Live desktop video, audio, and user input on a separate WebSocket. `?computer=` names
//! the computer to watch, the runtime's own when absent.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequest, Request};
use axum::response::{IntoResponse, Response};
use bytes::{BufMut, Bytes, BytesMut};
use futures::{SinkExt, StreamExt};
use http::{HeaderMap, StatusCode, header};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::computer_service::{COMPUTER_SERVICE, ComputerConnection, LOCAL_COMPUTER_ID};
use super::computer_session::{ComputerSession, ComputerViewer, SessionStatus};
use super::picture_stream::{ScreenFrame, StreamEncoding};
use crate::lib::origin_guard::is_allowed_origin;
use crate::services::voice::voice_chat_service::{
    RecordingFrame, VOICE_CHAT_SERVICE, is_recording_frame,
};
use crate::services::websocket_upgrades::serve_upgrades;
use crate::{log_info, log_warn};

pub const COMPUTER_PATH: &str = "/api/computer";

/// A JSON frame to a viewer socket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ComputerFrame {
    /// How the agent's screen is encoded, before any of it arrives and again whenever the
    /// source restarts. Video arrives as binary frames.
    ScreenStart {
        encoding: StreamEncoding,
        /// With `h264`: the name the browser configures its decoder with.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        codec: Option<String>,
    },
    /// One picture of the agent's screen, as base64 JPEG.
    Screen { data: String },
    /// Why this socket is closing, when it is not the client's doing.
    Error { message: String },
    /// The call is recording the user's screen, so the page may open its microphone.
    ///
    /// Answered on this socket, which is the one the request arrived on: the microphone
    /// travels on the other, and two sockets have no order between them.
    RecordingStarted,
}

/// What a viewer socket is told about its computer whenever anything about it changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerStateFrame {
    /// Always `computer_state`.
    #[serde(rename = "type")]
    pub kind: String,
    pub client_id: String,
    #[serde(flatten)]
    pub status: SessionStatus,
    pub connection: ComputerConnection,
    /// A connected computer can still lack the permission to send its screen.
    pub screen: bool,
}

/// The first byte of a binary frame says what is in it. The second is padding, so audio
/// samples start on a 2-byte boundary, and says whether a picture stands on its own.
pub const DESKTOP_AUDIO_FRAME: u8 = 0x02;
pub const SCREEN_VIDEO_FRAME: u8 = 0x03;

fn tagged(tag: u8, body: &[u8], flag: u8) -> Bytes {
    let mut frame = BytesMut::with_capacity(body.len() + 2);
    frame.put_u8(tag);
    frame.put_u8(flag);
    frame.put_slice(body);
    frame.freeze()
}

/// How much unsent data the socket may hold before the screen is skipped.
///
/// The desktop's audio and its screen share this socket, and the screen is the half that
/// can be skipped: a late frame of sound is heard, where a skipped picture costs one frame
/// of a stream that sends another within the tick. Roughly two pictures' worth, so an
/// ordinary burst is buffered and a client that has stopped draining is not fed.
///
/// Video is skipped a whole run at a time, up to the next picture that stands on its own,
/// since every picture between them is read against the one before it.
const SCREEN_BACKLOG_BYTES: usize = 256 * 1024;

/// How often a live socket is pinged, and so how long a client that went away silently
/// keeps the screen being captured for nobody. The chat gateway uses the same interval.
const LIVENESS_INTERVAL_MS: u64 = 30_000;

/// One viewer socket, as the endpoint writes to it.
#[derive(Clone)]
struct ViewerSocket {
    /// Frames for the task that writes the socket.
    outgoing: mpsc::UnboundedSender<Message>,
    /// Bytes handed to the writer and not yet sent.
    buffered: Arc<AtomicUsize>,
    /// Whether the socket answered the last ping.
    alive: Arc<AtomicBool>,
    /// Whether the socket is open.
    open: Arc<AtomicBool>,
    /// Ends the connection at once, as `terminate()` does.
    terminate: CancellationToken,
}

impl ViewerSocket {
    fn send(&self, message: Message) {
        if !self.open.load(Ordering::SeqCst) {
            return;
        }
        let size = message_size(&message);
        self.buffered.fetch_add(size, Ordering::SeqCst);
        if self.outgoing.send(message).is_err() {
            self.buffered.fetch_sub(size, Ordering::SeqCst);
        }
    }

    fn buffered_amount(&self) -> usize {
        self.buffered.load(Ordering::SeqCst)
    }

    /// Close with `code` and `reason`.
    fn close(&self, code: u16, reason: &str) {
        self.send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_string().into(),
        })));
    }
}

fn message_size(message: &Message) -> usize {
    match message {
        Message::Text(text) => text.len(),
        Message::Binary(data) => data.len(),
        _ => 0,
    }
}

/// How the session sends one socket the screen and the desktop's sound.
struct SocketViewer {
    socket: ViewerSocket,
    /// Whether video is being skipped right now, and so whether the next picture that
    /// stands on its own ends the skip. Per socket, which is per watcher.
    skipping: AtomicBool,
}

impl ComputerViewer for SocketViewer {
    fn screen(&self, frame: ScreenFrame) {
        let socket = &self.socket;
        if !socket.open.load(Ordering::SeqCst) {
            return;
        }
        match frame {
            ScreenFrame::Start { encoding, codec } => {
                self.skipping.store(false, Ordering::SeqCst);
                send(socket, &ComputerFrame::ScreenStart { encoding, codec });
            }
            ScreenFrame::Jpeg { data } => {
                if socket.buffered_amount() > SCREEN_BACKLOG_BYTES {
                    return;
                }
                send(socket, &ComputerFrame::Screen { data });
            }
            ScreenFrame::H264 { data, keyframe } => {
                // A run of video is skipped whole: every picture between two that stand on
                // their own is read against the one before it, so resuming mid-run decodes
                // to nothing.
                if self.skipping.load(Ordering::SeqCst) && !keyframe {
                    return;
                }
                let buffered = socket.buffered_amount();
                if buffered > SCREEN_BACKLOG_BYTES {
                    if !self.skipping.swap(true, Ordering::SeqCst) {
                        log_warn!(
                            "[Computer] Skipping video: {} bytes are still unsent on the client socket",
                            buffered
                        );
                    }
                    return;
                }
                self.skipping.store(false, Ordering::SeqCst);
                socket.send(Message::Binary(tagged(
                    SCREEN_VIDEO_FRAME,
                    &data,
                    if keyframe { 1 } else { 0 },
                )));
            }
        }
    }

    fn audio(&self, pcm: Bytes) {
        if !self.socket.open.load(Ordering::SeqCst) {
            return;
        }
        self.socket
            .send(Message::Binary(tagged(DESKTOP_AUDIO_FRAME, &pcm, 0)));
    }
}

/// An upgrade refused before it is upgraded, with the connection closed.
fn refuse(status: StatusCode) -> Response {
    let mut response = (status, Body::empty()).into_response();
    response
        .headers_mut()
        .insert(header::CONNECTION, http::HeaderValue::from_static("close"));
    response
}

/// A header as Node gives it: repeated values joined with `, `.
fn joined_header(headers: &HeaderMap, name: header::HeaderName) -> Option<String> {
    let values: Vec<&str> = headers
        .get_all(name)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

/// `searchParams.get('computer') || LOCAL_COMPUTER_ID`.
fn computer_param(req: &Request) -> String {
    req.uri()
        .query()
        .and_then(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .find(|(key, _)| key == "computer")
                .map(|(_, value)| value.into_owned())
        })
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| LOCAL_COMPUTER_ID.to_string())
}

pub struct ComputerEndpoint {
    /// The open sockets, by client id.
    sockets: Mutex<HashMap<String, ViewerSocket>>,
    liveness: Mutex<Option<JoinHandle<()>>>,
}

pub static COMPUTER_ENDPOINT: LazyLock<ComputerEndpoint> = LazyLock::new(ComputerEndpoint::new);

impl ComputerEndpoint {
    pub fn new() -> Self {
        ComputerEndpoint {
            sockets: Mutex::new(HashMap::new()),
            liveness: Mutex::new(None),
        }
    }

    /// Serve this endpoint's upgrades on `COMPUTER_PATH` through `websocket_upgrades`, and
    /// ping every socket each `LIVENESS_INTERVAL_MS`: a socket that does not answer a ping
    /// is gone, whatever TCP still believes, and is ended with `[Computer] Ending a socket
    /// that stopped answering`.
    pub fn initialize(&'static self) {
        serve_upgrades(
            COMPUTER_PATH,
            Arc::new(move |req| Box::pin(self.handle_upgrade(req))),
        );
        let liveness = tokio::spawn(async move {
            let period = Duration::from_millis(LIVENESS_INTERVAL_MS);
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            loop {
                ticks.tick().await;
                let sockets: Vec<ViewerSocket> = self.sockets.lock().values().cloned().collect();
                for socket in sockets {
                    if !socket.alive.load(Ordering::SeqCst) {
                        log_info!("[Computer] Ending a socket that stopped answering");
                        socket.terminate.cancel();
                        continue;
                    }
                    socket.alive.store(false, Ordering::SeqCst);
                    socket.send(Message::Ping(Bytes::new()));
                }
            }
        });
        if let Some(previous) = self.liveness.lock().replace(liveness) {
            previous.abort();
        }
        log_info!("[Computer] Screen endpoint listening on {}", COMPUTER_PATH);
    }

    /// One upgrade to `COMPUTER_PATH`. A WebSocket handshake is exempt from the same-origin
    /// policy, so the rules the HTTP routes and `/api/ws` get are applied to it here: a
    /// refused origin answers 403, and a computer that does not exist 404.
    pub async fn handle_upgrade(&'static self, req: Request) -> Response {
        let headers = req.headers();
        let origin = joined_header(headers, header::ORIGIN);
        let host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let forwarded = joined_header(headers, header::HeaderName::from_static("x-forwarded-host"));
        if !is_allowed_origin(origin.as_deref(), host.as_deref(), forwarded.as_deref()) {
            log_warn!(
                "[Computer] refused a handshake (origin {}, host {}, x-forwarded-host {})",
                origin.as_deref().unwrap_or("undefined"),
                host.as_deref().unwrap_or("undefined"),
                forwarded.as_deref().unwrap_or("undefined")
            );
            return refuse(StatusCode::FORBIDDEN);
        }
        let computer_id = computer_param(&req);
        let Some(session) = COMPUTER_SERVICE.session(&computer_id) else {
            return refuse(StatusCode::NOT_FOUND);
        };
        let upgrade = match WebSocketUpgrade::from_request(req, &()).await {
            Ok(upgrade) => upgrade,
            Err(rejection) => return rejection.into_response(),
        };
        upgrade.on_upgrade(move |ws| self.serve(ws, session))
    }

    /// Serve one viewer of `session`: its state on every change, its frames to the session
    /// or to the voice call's recording, and the screen while it is attached.
    async fn serve(&'static self, ws: WebSocket, session: Arc<ComputerSession>) {
        let id = uuid::Uuid::new_v4().to_string();
        let (mut sink, mut stream) = ws.split();
        let (outgoing, mut queue) = mpsc::unbounded_channel::<Message>();
        let socket = ViewerSocket {
            outgoing,
            buffered: Arc::new(AtomicUsize::new(0)),
            alive: Arc::new(AtomicBool::new(true)),
            open: Arc::new(AtomicBool::new(true)),
            terminate: CancellationToken::new(),
        };
        let writer = {
            let socket = socket.clone();
            tokio::spawn(async move {
                while let Some(message) = queue.recv().await {
                    let size = message_size(&message);
                    let closing = matches!(message, Message::Close(_));
                    let sent = sink.send(message).await;
                    socket.buffered.fetch_sub(size, Ordering::SeqCst);
                    if sent.is_err() || closing {
                        socket.open.store(false, Ordering::SeqCst);
                        break;
                    }
                }
            })
        };
        self.sockets.lock().insert(id.clone(), socket.clone());

        let state = {
            let socket = socket.clone();
            let session = session.clone();
            let id = id.clone();
            Arc::new(move || {
                if !socket.open.load(Ordering::SeqCst) {
                    return;
                }
                let summary = COMPUTER_SERVICE
                    .summaries()
                    .into_iter()
                    .find(|item| item.id == session.id);
                let connection = summary
                    .as_ref()
                    .map_or(ComputerConnection::Disconnected, |summary| {
                        summary.connection
                    });
                let screen = connection == ComputerConnection::Connected
                    && summary.as_ref().is_some_and(|summary| {
                        summary.capabilities.iter().any(|item| item == "stream")
                    });
                let frame = ComputerStateFrame {
                    kind: "computer_state".to_string(),
                    client_id: id.clone(),
                    status: session.status(),
                    connection,
                    screen,
                };
                if let Ok(text) = serde_json::to_string(&frame) {
                    socket.send(Message::Text(text.into()));
                }
            })
        };
        let listener = COMPUTER_SERVICE.on_change(state.clone());
        state();

        let viewer = Arc::new(SocketViewer {
            socket: socket.clone(),
            skipping: AtomicBool::new(false),
        });
        {
            let (session, socket, state, id) =
                (session.clone(), socket.clone(), state.clone(), id.clone());
            tokio::spawn(async move {
                match session.attach(&id, viewer).await {
                    Ok(detach) => {
                        if !socket.open.load(Ordering::SeqCst) {
                            detach();
                        }
                        state();
                    }
                    Err(err) => {
                        send(
                            &socket,
                            &ComputerFrame::Error {
                                message: err.to_string(),
                            },
                        );
                        socket.close(1011, "computer unavailable");
                    }
                }
            });
        }

        loop {
            let message = tokio::select! {
                message = stream.next() => message,
                _ = socket.terminate.cancelled() => break,
            };
            let Some(Ok(message)) = message else {
                break;
            };
            match message {
                Message::Text(text) => self.on_text(&id, &session, &socket, text.as_str()),
                Message::Pong(_) => socket.alive.store(true, Ordering::SeqCst),
                Message::Close(_) => break,
                Message::Binary(_) | Message::Ping(_) => {}
            }
        }

        socket.open.store(false, Ordering::SeqCst);
        writer.abort();
        self.sockets.lock().remove(&id);
        COMPUTER_SERVICE.off_change(listener);
        session.detach(&id);
        // The pictures and the end of a recording were going to arrive on this socket.
        VOICE_CHAT_SERVICE.release_recording_client(&id);
    }

    /// A text frame from a viewer. A recording belongs to the call this page started rather
    /// than to the desktop it shows, so those frames go to the voice call and the rest to
    /// the computer.
    fn on_text(&self, id: &str, session: &ComputerSession, socket: &ViewerSocket, text: &str) {
        let Ok(frame) = serde_json::from_str::<Value>(text) else {
            return;
        };
        if is_recording_frame(frame.get("type").unwrap_or(&Value::Null)) {
            if let Ok(recording) = serde_json::from_value::<RecordingFrame>(frame) {
                let socket = socket.clone();
                VOICE_CHAT_SERVICE.handle_recording_frame(id, recording, move || {
                    send(&socket, &ComputerFrame::RecordingStarted)
                });
            }
            return;
        }
        session.input(id, text);
    }

    /// Stop taking connections; called from the process shutdown path. Closes every socket
    /// with 1001.
    pub fn close(&self) {
        let sockets: Vec<ViewerSocket> = self.sockets.lock().values().cloned().collect();
        for socket in sockets {
            socket.close(1001, "runtime shutting down");
        }
        if let Some(liveness) = self.liveness.lock().take() {
            liveness.abort();
        }
    }
}

impl Default for ComputerEndpoint {
    fn default() -> Self {
        ComputerEndpoint::new()
    }
}

/// One JSON frame to a socket, while it is open.
fn send(socket: &ViewerSocket, frame: &ComputerFrame) {
    if !socket.open.load(Ordering::SeqCst) {
        return;
    }
    if let Ok(text) = serde_json::to_string(frame) {
        socket.send(Message::Text(text.into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_a_binary_frame_with_its_kind_and_whether_it_stands_alone() {
        assert_eq!(
            tagged(SCREEN_VIDEO_FRAME, &[9, 8], 1).as_ref(),
            &[0x03, 1, 9, 8]
        );
        assert_eq!(tagged(DESKTOP_AUDIO_FRAME, &[], 0).as_ref(), &[0x02, 0]);
    }

    #[test]
    fn writes_the_frames_a_viewer_reads() {
        let start = ComputerFrame::ScreenStart {
            encoding: StreamEncoding::H264,
            codec: Some("avc1.64001F".into()),
        };
        assert_eq!(
            serde_json::to_string(&start).unwrap(),
            r#"{"type":"screen_start","encoding":"h264","codec":"avc1.64001F"}"#
        );
        let jpeg = ComputerFrame::ScreenStart {
            encoding: StreamEncoding::Jpeg,
            codec: None,
        };
        assert_eq!(
            serde_json::to_string(&jpeg).unwrap(),
            r#"{"type":"screen_start","encoding":"jpeg"}"#
        );
        assert_eq!(
            serde_json::to_string(&ComputerFrame::RecordingStarted).unwrap(),
            r#"{"type":"recording_started"}"#
        );
    }

    #[test]
    fn writes_the_state_with_the_session_status_beside_the_client() {
        let frame = ComputerStateFrame {
            kind: "computer_state".to_string(),
            client_id: "client-1".to_string(),
            status: SessionStatus {
                computer_id: "local".into(),
                available: true,
                running: false,
                starting: true,
                paused: false,
                secure: false,
                controller: None,
                owner: None,
                waiting: Vec::new(),
            },
            connection: ComputerConnection::Connected,
            screen: true,
        };
        assert_eq!(
            serde_json::to_string(&frame).unwrap(),
            r#"{"type":"computer_state","clientId":"client-1","computerId":"local","available":true,"running":false,"starting":true,"paused":false,"secure":false,"controller":null,"owner":null,"waiting":[],"connection":"connected","screen":true}"#
        );
    }

    fn socket() -> (ViewerSocket, mpsc::UnboundedReceiver<Message>) {
        let (outgoing, queue) = mpsc::unbounded_channel();
        (
            ViewerSocket {
                outgoing,
                buffered: Arc::new(AtomicUsize::new(0)),
                alive: Arc::new(AtomicBool::new(true)),
                open: Arc::new(AtomicBool::new(true)),
                terminate: CancellationToken::new(),
            },
            queue,
        )
    }

    #[test]
    fn skips_video_a_whole_run_at_a_time_while_the_socket_is_backed_up() {
        let (socket, mut queue) = socket();
        let viewer = SocketViewer {
            socket: socket.clone(),
            skipping: AtomicBool::new(false),
        };
        let picture = |keyframe| ScreenFrame::H264 {
            data: Bytes::from_static(&[1, 2, 3]),
            keyframe,
        };
        socket
            .buffered
            .store(SCREEN_BACKLOG_BYTES + 1, Ordering::SeqCst);
        viewer.screen(picture(false));
        assert!(queue.try_recv().is_err());

        // The socket drained, but the run that was skipped cannot be decoded.
        socket.buffered.store(0, Ordering::SeqCst);
        viewer.screen(picture(false));
        assert!(queue.try_recv().is_err());

        viewer.screen(picture(true));
        let Ok(Message::Binary(sent)) = queue.try_recv() else {
            panic!("the keyframe goes out");
        };
        assert_eq!(sent.as_ref(), &[0x03, 1, 1, 2, 3]);
        viewer.screen(picture(false));
        assert!(queue.try_recv().is_ok());
    }

    #[test]
    fn sends_the_desktops_sound_whatever_the_backlog() {
        let (socket, mut queue) = socket();
        let viewer = SocketViewer {
            socket: socket.clone(),
            skipping: AtomicBool::new(false),
        };
        socket
            .buffered
            .store(SCREEN_BACKLOG_BYTES * 2, Ordering::SeqCst);
        viewer.audio(Bytes::from_static(&[0, 1]));
        let Ok(Message::Binary(sent)) = queue.try_recv() else {
            panic!("the sound goes out");
        };
        assert_eq!(sent.as_ref(), &[0x02, 0, 0, 1]);
    }
}
