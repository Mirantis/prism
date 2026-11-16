//! WebSocket Gateway Service
//!
//! The chat socket, `/api/ws`: protocol version 2, which
//! `docs/websocket-protocol.md` describes for client authors and
//! `protocol/chat_protocol.rs` pins down.
//!
//! A client says `hello` and is answered `welcome`. From then on it reads one
//! numbered stream of events — every message in every conversation, the person's
//! own included, and what each conversation is doing — and a client that was away
//! names where it stopped and is sent the rest. What it sends is a request with an
//! id, answered `ack` or `nack` under that id. A message is confirmed once it is
//! stored, so a client resends anything unconfirmed without fear of a duplicate.
//!
//! The gateway owns connections and nothing else. The stream is
//! `EVENT_STREAM_SERVICE`'s, and what happens to a message is
//! `INBOUND_MESSAGE_SERVICE`'s.
//!
//! Each connection is one axum WebSocket: a reader task that hands every frame to
//! the gateway, and a writer task that owns the socket's sink and drains the
//! socket's outbound queue. The queue's unsent byte count stands in for
//! `ws.bufferedAmount`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Weak};
use std::time::Duration;

use axum::extract::FromRequestParts;
use axum::extract::Request;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use http::{HeaderMap, StatusCode};
use indexmap::IndexMap;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;
use tokio::task::{AbortHandle, JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::config::CONFIG;
use crate::lib::forwarded_sender::{ForwardedSender, header_of, sender_of};
use crate::lib::log_redaction::err_json;
use crate::lib::origin_guard::is_allowed_origin;
use crate::lib::telemetry::track_event;
use crate::lib::token_bucket::TokenBucket;
use crate::protocol::chat_protocol::{
    AckPayload, CLOSE_CODES, ClientFrame, DirectFrame, HELLO_TIMEOUT_MS, MAX_FRAME_BYTES, NackCode,
    NackPayload, PROTOCOL_VERSION, SendAckPayload, SnapshotTurn, StreamEvent, ThreadEventPayload,
    WelcomePayload, WelcomeSnapshot, WelcomeYou, parse_client_frame, parse_hello_frame,
};
use crate::services::compaction_service::COMPACTION_SERVICE;
use crate::services::computer::computer_help_service::COMPUTER_HELP_SERVICE;
use crate::services::computer::computer_service::COMPUTER_SERVICE;
use crate::services::context_usage_service::CONTEXT_USAGE_SERVICE;
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::services::event_stream_service::{EVENT_STREAM_SERVICE, StreamEntry, Unsubscribe};
use crate::services::inbound_message_service::{
    INBOUND_MESSAGE_SERVICE, InboundMessage, InboundMessageError, InboundSender,
};
use crate::services::meeting::openai_endpoint::is_realtime_configured;
use crate::services::meeting::resampler::MEETING_SAMPLE_RATE;
use crate::services::thread_title_service::THREAD_TITLE_SERVICE;
use crate::services::update::update_service::UPDATE_SERVICE;
use crate::services::voice::dictation_session::{
    DictationCancelReason, DictationSession, DictationSessionOptions, DictationSignal,
};
use crate::services::voice::socket_audio::{SocketAudioChannel, VOICE_AUDIO_FORMAT};
use crate::services::voice::voice_chat_service::{
    ScreenRect, StartVoiceChatInput, VOICE_CHAT_SERVICE, VoiceChatEndStatus, VoiceChatLiveInfo,
    VoiceChatSignal, VoiceChatState, VoiceChatSurface, VoiceListeningMode,
};
use crate::support::js;
use crate::{log_error, log_info, log_warn};

/// Where the Web UI's chat and its voice connect. The screen has its own path; see
/// `services/computer/computer_endpoint.rs`.
pub const CHAT_PATH: &str = "/api/ws";

/// How many sockets the agent keeps at once. A newer one replaces the oldest
/// rather than being refused: the oldest is usually a phone's socket that died
/// behind a locked screen and has not been noticed yet, and refusing the phone's
/// fresh one would lock its owner out until the heartbeat caught up.
pub const MAX_CONNECTIONS: usize = 16;

/// How long a new socket waits, at the limit, for a socket that is closing to report it.
const CLOSE_GRACE_MS: u64 = 20;

/// How much may sit unsent on one socket before the gateway stops trying. A
/// client that far behind is closed and resumes from the replay window, which
/// costs the server nothing, instead of growing a queue in its memory.
pub const MAX_BUFFERED_BYTES: usize = 4 * 1024 * 1024;

/// How often the protocol-level heartbeat pings every socket, terminating one that
/// did not answer the previous ping.
const HEARTBEAT_INTERVAL_MS: u64 = 30_000;

/// How long a socket that was sent a close frame has to answer it before the
/// connection is dropped, as the `ws` server waits.
const CLOSE_TIMEOUT_MS: u64 = 30_000;

/// How much of the agent's speech may sit unsent on a socket before frames are dropped.
///
/// Two seconds at the one rate the protocol carries. A client that cannot keep up is
/// behind on the conversation, not merely behind on the audio: what is queued is already
/// stale by the time it plays, and the queue grows for as long as the call runs. Dropping
/// keeps the delay bounded, which is what a media transport would have done here.
const MAX_BUFFERED_AUDIO_BYTES: usize = VOICE_AUDIO_FORMAT.sample_rate as usize * 2 * 2;

/// One chat socket: its state, and the handle the gateway sends through.
pub struct ChatSocket {
    /// Identifies the socket in the gateway's lists.
    id: u64,
    /// Frames for the writer task, which owns the socket's sink.
    outbound: mpsc::UnboundedSender<Message>,
    /// Bytes handed to the writer and not yet written (`ws.bufferedAmount`).
    buffered_amount: AtomicUsize,
    /// `readyState === OPEN`: cleared once a close starts or the connection ends.
    open: AtomicBool,
    /// The close code this side sent, when it started the close.
    sent_close: Mutex<Option<u16>>,
    /// Ends the reader and the writer at once, without a close handshake
    /// (`ws.terminate()`).
    terminate: CancellationToken,
    is_alive: AtomicBool,
    /// Set once the socket said `hello` and was answered. Nothing else is read before.
    ready: AtomicBool,
    /// Set while a `hello` is being answered, so a second one cannot start another.
    greeting: AtomicBool,
    /// Who the ingress says is on this connection. Display and attribution only.
    sender: Option<ForwardedSender>,
    hello_timer: Mutex<Option<AbortHandle>>,
    /// Stops this socket's stream subscription.
    unsubscribe: Mutex<Option<Unsubscribe>>,
    /// A send is the expensive request; everything else is cheap.
    sends: Mutex<TokenBucket>,
    requests: Mutex<TokenBucket>,
}

impl ChatSocket {
    fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Queue a frame for the writer, counting it as unsent until it is written.
    fn queue(&self, message: Message) {
        self.buffered_amount
            .fetch_add(message_len(&message), Ordering::SeqCst);
        if self.outbound.send(message).is_err() {
            self.buffered_amount.store(0, Ordering::SeqCst);
        }
    }

    fn send_text(&self, text: String) {
        if !self.is_open() {
            return;
        }
        self.queue(Message::Text(text.into()));
    }

    fn send_binary(&self, data: Bytes) {
        if !self.is_open() {
            return;
        }
        self.queue(Message::Binary(data));
    }

    /// Start the close handshake with `code`. A socket that does not answer it is
    /// dropped after `CLOSE_TIMEOUT_MS`.
    fn close(&self, code: u16, reason: &str) {
        if !self.open.swap(false, Ordering::SeqCst) {
            return;
        }
        *self.sent_close.lock() = Some(code);
        let _ = self.outbound.send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })));
        let terminate = self.terminate.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(CLOSE_TIMEOUT_MS)).await;
            terminate.cancel();
        });
    }

    /// Drop the connection without a close handshake.
    fn terminate(&self) {
        self.open.store(false, Ordering::SeqCst);
        self.terminate.cancel();
    }
}

/// The bytes a frame puts on the wire, for `buffered_amount`.
fn message_len(message: &Message) -> usize {
    match message {
        Message::Text(text) => text.len(),
        Message::Binary(data) | Message::Ping(data) | Message::Pong(data) => data.len(),
        Message::Close(_) => 0,
    }
}

/// The voice request being answered, and whether its client gave up while it waited.
struct VoiceStarting {
    ws: Arc<ChatSocket>,
    cancelled: Option<VoiceChatEndStatus>,
}

/// A send request's message, as `handle_send` stores it.
#[derive(Debug, Clone)]
struct SentMessage {
    id: String,
    thread_id: String,
    content: String,
    attachment_ids: Vec<String>,
}

/// The rectangle a client will show the agent's screen in, in its own device pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
struct RequestedScreen {
    width: f64,
    height: f64,
}

/// Which listening mode a `voice_start` asked for.
enum ListeningModeRequest {
    /// The client said nothing, which takes the default.
    Unset,
    Mode(VoiceListeningMode),
    /// The client asked for something this does not serve.
    Unsupported,
}

/// How the voice service answers the client that asked for the session: the
/// `VoiceChatSignal` the gateway hands `VOICE_CHAT_SERVICE.start`.
///
/// `send_audio` sends pcm as a binary frame, dropping it while more than
/// `MAX_BUFFERED_AUDIO_BYTES` sit unsent (logged once per stall as
/// `Dropping voice audio: {n} bytes are still unsent on the client socket`);
/// `send_clear` sends `voice_clear`; `state` frees the voice socket on `ended`
/// and sends `voice_state` with the info spread in; `error` sends `voice_error`.
struct SocketVoiceSignal {
    ws: Arc<ChatSocket>,
    /// Whether the speech is being dropped right now, so a stalled client costs one
    /// log line rather than fifty a second. Per signal, which is per session.
    dropping: AtomicBool,
}

impl SocketAudioChannel for SocketVoiceSignal {
    fn send_audio(&self, pcm: Bytes) {
        if !self.ws.is_open() {
            return;
        }
        // A socket that is not draining takes the speech into memory instead, and the
        // agent talks for as long as the call lasts. Drop the frame rather than queue it:
        // what is already queued plays later than it was meant to, and adding to it makes
        // the lag permanent. The client hears a gap, which is what a lost packet sounds
        // like on any other transport.
        let buffered = self.ws.buffered_amount.load(Ordering::SeqCst);
        if buffered > MAX_BUFFERED_AUDIO_BYTES {
            if !self.dropping.swap(true, Ordering::SeqCst) {
                log_warn!(
                    "Dropping voice audio: {} bytes are still unsent on the client socket",
                    buffered
                );
            }
            return;
        }
        self.dropping.store(false, Ordering::SeqCst);
        self.ws.send_binary(pcm);
    }

    fn send_clear(&self) {
        WEB_SOCKET_GATEWAY_SERVICE.send_to(&self.ws, &DirectFrame::VoiceClear);
    }
}

impl VoiceChatSignal for SocketVoiceSignal {
    fn state(&self, state: VoiceChatState, info: Option<VoiceChatLiveInfo>) {
        if state == VoiceChatState::Ended {
            let mut voice_socket = WEB_SOCKET_GATEWAY_SERVICE.voice_socket.lock();
            if voice_socket
                .as_ref()
                .is_some_and(|holder| Arc::ptr_eq(holder, &self.ws))
            {
                *voice_socket = None;
            }
        }
        // `desktop` rides the live state: the client needs it before it decides whether
        // to offer the pointer and the keyboard on the screen it is about to show.
        let mut payload = Map::new();
        payload.insert("state".into(), json!(state.as_str()));
        if let Some(Value::Object(fields)) = info.map(|info| json!(info)) {
            payload.extend(fields);
        }
        WEB_SOCKET_GATEWAY_SERVICE.send_to(
            &self.ws,
            &DirectFrame::VoiceState {
                payload: Value::Object(payload),
            },
        );
    }

    fn error(&self, message: &str) {
        WEB_SOCKET_GATEWAY_SERVICE.send_to(
            &self.ws,
            &DirectFrame::VoiceError {
                payload: json!({ "error": message }),
            },
        );
    }
}

/// How a dictation answers its socket: `dictation_hello` with the audio format when
/// ready, `dictation_delta`, `dictation_result` and `dictation_error`.
struct SocketDictationSignal {
    ws: Arc<ChatSocket>,
}

impl DictationSignal for SocketDictationSignal {
    fn ready(&self) {
        WEB_SOCKET_GATEWAY_SERVICE.send_to(
            &self.ws,
            &DirectFrame::DictationHello {
                payload: json!({ "format": VOICE_AUDIO_FORMAT }),
            },
        );
    }

    fn delta(&self, text: &str) {
        WEB_SOCKET_GATEWAY_SERVICE.send_to(
            &self.ws,
            &DirectFrame::DictationDelta {
                payload: json!({ "text": text }),
            },
        );
    }

    fn result(&self, text: &str) {
        WEB_SOCKET_GATEWAY_SERVICE.send_to(
            &self.ws,
            &DirectFrame::DictationResult {
                payload: json!({ "text": text }),
            },
        );
    }

    fn error(&self, message: &str) {
        WEB_SOCKET_GATEWAY_SERVICE.send_to(
            &self.ws,
            &DirectFrame::DictationError {
                payload: json!({ "error": message }),
            },
        );
    }
}

/// A payload field, when the client sent it as a string with something in it.
fn string_field(payload: &Map<String, Value>, key: &str) -> Option<String> {
    match payload.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// The rectangle the client will show the agent's screen in, in its own device pixels.
///
/// Read off the start request rather than sent later, so the desktop comes up at the size
/// it will be watched at instead of laying itself out twice. A client that leaves it off
/// takes the default and can resize afterwards.
fn screen_of(payload: &Map<String, Value>) -> Option<RequestedScreen> {
    let screen = payload.get("screen")?.as_object()?;
    let width = screen.get("width")?.as_f64()?;
    let height = screen.get("height")?.as_f64()?;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return None;
    }
    Some(RequestedScreen { width, height })
}

/// Which listening mode the client asked for.
///
/// `Unsupported` is refused rather than defaulted, which is the opposite of how the rest
/// of this payload is read. The modes do not differ only in how much the agent says: in
/// `open` it answers every utterance, and an answer can be a tool call the runtime
/// executes for real. So a client that means `addressed` and misspells it would get an
/// agent that talks over a room and acts on what it hears there, with nothing in the
/// frames to say why. A client that sent the field asked for something specific, and it
/// is cheaper to be told than to find out from the room. A JSON `null` is something the
/// client sent, so it is `Unsupported` too.
fn listening_mode(payload: &Map<String, Value>) -> ListeningModeRequest {
    match payload.get("mode") {
        None => ListeningModeRequest::Unset,
        Some(Value::String(s)) if s == "open" => {
            ListeningModeRequest::Mode(VoiceListeningMode::Open)
        }
        Some(Value::String(s)) if s == "addressed" => {
            ListeningModeRequest::Mode(VoiceListeningMode::Addressed)
        }
        Some(_) => ListeningModeRequest::Unsupported,
    }
}

/// The request id of a frame that failed to parse, when it had a readable one.
fn request_id_of(value: &Value) -> Option<String> {
    let id = value.as_object()?.get("id")?.as_str()?;
    let len = js::len16(id);
    (len > 0 && len <= 64).then(|| id.to_string())
}

/// An event payload as a JSON object.
fn object_of<T: serde::Serialize>(value: &T) -> Map<String, Value> {
    match serde_json::to_value(value) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

// ============================================================================
// WebSocket Gateway Service
// ============================================================================

pub struct WebSocketGatewayService {
    /// Set once `initialize` ran: the event subscriptions and the heartbeat exist.
    initialized: AtomicBool,
    next_socket_id: AtomicU64,
    /// Every socket, oldest first, whether or not it has said `hello` yet.
    connections: Mutex<Vec<Arc<ChatSocket>>>,
    /// The socket whose request holds the voice session, from the moment the gateway
    /// decides to open one until it is over — so closing it ends the call. Taken
    /// before the service is asked, because the service reports `live` from inside
    /// that call and the client's first frames are dropped while this is unset. Every
    /// other request is refused while it is taken, which is also what keeps it
    /// truthful: a request that was refused never becomes this socket, and so cannot
    /// end somebody else's call by going away.
    voice_socket: Mutex<Option<Arc<ChatSocket>>>,
    /// Whether the client of the request being answered gave up while it waited, and
    /// which way. A stop or a disconnect that lands before the answer has no session
    /// to end yet, so it is honoured once the start returns. One record, because
    /// `voice_socket` above refuses a second request while this one is outstanding.
    voice_starting: Mutex<Option<VoiceStarting>>,
    /// Whether a computer-state event is being built, and whether the desktop changed
    /// again while it was. One build at a time keeps a burst of changes to one database
    /// read, and the flag makes the last event published the newest state.
    computer_publishing: AtomicBool,
    computer_changed_again: AtomicBool,
    /// The dictation each socket is recording, from `dictation_start` until it ends,
    /// keyed by socket id. One per socket and any number per runtime, since a dictation
    /// never takes the agent's voice.
    dictations: Mutex<HashMap<u64, Arc<DictationSession>>>,
    /// The protocol-level heartbeat, which terminates a socket that stopped answering.
    heartbeat: Mutex<Option<JoinHandle<()>>>,
}

impl Default for WebSocketGatewayService {
    fn default() -> Self {
        Self::new()
    }
}

impl WebSocketGatewayService {
    pub fn new() -> Self {
        WebSocketGatewayService {
            initialized: AtomicBool::new(false),
            next_socket_id: AtomicU64::new(1),
            connections: Mutex::new(Vec::new()),
            voice_socket: Mutex::new(None),
            voice_starting: Mutex::new(None),
            computer_publishing: AtomicBool::new(false),
            computer_changed_again: AtomicBool::new(false),
            dictations: Mutex::new(HashMap::new()),
            heartbeat: Mutex::new(None),
        }
    }

    /// Put the channel-agnostic services' events on the stream. Everything here is
    /// owned by another service; the gateway only publishes it:
    ///
    /// - a thread title change → `thread` `{ threadId, title }`;
    /// - a created thread → `thread` `{ threadId, title, createdAt }` (ISO text), so a
    ///   conversation started on one device appears in every other device's list;
    /// - context usage → `context` (the event without `userId`);
    /// - a compaction → `compaction` (the event without `userId`);
    /// - an update event → `update`;
    /// - a change of any computer → `publish_computer`. Every computer's access gate
    ///   feeds that emitter, so every caller that queues for one reaches the clients.
    fn subscribe_events(&'static self) {
        THREAD_TITLE_SERVICE.events.on_change(|change| {
            EVENT_STREAM_SERVICE.publish(StreamEvent::Thread(ThreadEventPayload {
                thread_id: change.thread_id.clone(),
                title: Some(change.title.clone()),
                created_at: None,
            }));
        });

        CONVERSATION_SERVICE.events.on_thread(|created| {
            EVENT_STREAM_SERVICE.publish(StreamEvent::Thread(ThreadEventPayload {
                thread_id: created.thread_id.clone(),
                title: created.title.clone(),
                created_at: Some(crate::support::iso(&created.created_at)),
            }));
        });

        CONTEXT_USAGE_SERVICE.events.on_usage(|usage| {
            EVENT_STREAM_SERVICE.publish(StreamEvent::Context(object_of(&usage.snapshot)));
        });

        COMPACTION_SERVICE.events.on_compaction(|compaction| {
            let mut payload = object_of(compaction);
            payload.shift_remove("userId");
            EVENT_STREAM_SERVICE.publish(StreamEvent::Compaction(payload));
        });

        let mut updates = UPDATE_SERVICE.events.subscribe();
        tokio::spawn(async move {
            loop {
                match updates.recv().await {
                    Ok(update) => {
                        EVENT_STREAM_SERVICE.publish(StreamEvent::Update(object_of(&update)));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        // The state of the computers: which threads wait for them, who holds them, which
        // are connected, and the open help requests. Every computer's access gate feeds
        // this emitter, so every caller that queues for one reaches the clients.
        COMPUTER_SERVICE.on_change(Arc::new(|| {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(WEB_SOCKET_GATEWAY_SERVICE.publish_computer());
            }
        }));
    }

    /// Publish the state of the desktop, coalescing a burst of changes into one event.
    ///
    /// The payload needs a database read, and one call on the access gate emits twice —
    /// a turn taking a free desktop is queued and then holds it — so the first build
    /// waits for the current tick to finish (`tokio::task::yield_now`), and a change
    /// that lands during a build schedules exactly one more.
    async fn publish_computer(&self) {
        if self.computer_publishing.swap(true, Ordering::SeqCst) {
            self.computer_changed_again.store(true, Ordering::SeqCst);
            return;
        }
        loop {
            // Let the rest of this tick emit before the state is read, so changes made
            // together are read together.
            tokio::task::yield_now().await;
            self.computer_changed_again.store(false, Ordering::SeqCst);
            if let Some(payload) = self.computer_state().await {
                EVENT_STREAM_SERVICE.publish(StreamEvent::Computer(payload));
            }
            if self.computer_changed_again.swap(false, Ordering::SeqCst) {
                continue;
            }
            self.computer_publishing.store(false, Ordering::SeqCst);
            // A change that landed between the last read and the release builds again.
            if self.computer_changed_again.swap(false, Ordering::SeqCst)
                && !self.computer_publishing.swap(true, Ordering::SeqCst)
            {
                continue;
            }
            return;
        }
    }

    /// The runtime's own desktop as `GET /computers/local` reads it, every help request
    /// (`help`), and the list of computers (`computers`); or `None` while no agent is
    /// loaded. A failed build is logged (`[Computer] Could not read the computer state`)
    /// and answered with `None`: the next change corrects every client.
    async fn computer_state(&self) -> Option<Map<String, Value>> {
        let agent_id = CONFIG.agent_id().filter(|id| !id.is_empty())?;
        let state = async {
            let mut state = object_of(&COMPUTER_SERVICE.local.status());
            let help = COMPUTER_HELP_SERVICE
                .list(&agent_id, &CONFIG.owner_user_id(), None)
                .await?;
            state.insert("help".into(), serde_json::to_value(help)?);
            state.insert(
                "computers".into(),
                serde_json::to_value(COMPUTER_SERVICE.summaries())?,
            );
            Ok::<Map<String, Value>, anyhow::Error>(state)
        }
        .await;
        match state {
            Ok(state) => Some(state),
            Err(error) => {
                log_warn!(
                    json!({ "err": err_json(&error) }),
                    "[Computer] Could not read the computer state"
                );
                None
            }
        }
    }

    /// Start serving the chat socket: register [`Self::handle_upgrade`] for
    /// `/api/ws` with `websocket_upgrades::serve_upgrades`, subscribe to the other
    /// services' events, and start the 30-second heartbeat that pings every socket
    /// and terminates one whose last ping went unanswered. Logs
    /// `WebSocket gateway initialized on /api/ws`.
    pub fn initialize(&'static self) {
        if !self.initialized.swap(true, Ordering::SeqCst) {
            self.subscribe_events();
            // Protocol-level heartbeat, which terminates a socket that stopped answering.
            let heartbeat = tokio::spawn(async move {
                let period = Duration::from_millis(HEARTBEAT_INTERVAL_MS);
                let mut interval =
                    tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                loop {
                    interval.tick().await;
                    let sockets = WEB_SOCKET_GATEWAY_SERVICE.connections.lock().clone();
                    for ws in sockets {
                        if !ws.is_alive.load(Ordering::SeqCst) {
                            ws.terminate();
                            continue;
                        }
                        ws.is_alive.store(false, Ordering::SeqCst);
                        if ws.is_open() {
                            ws.queue(Message::Ping(Bytes::new()));
                        }
                    }
                }
            });
            *self.heartbeat.lock() = Some(heartbeat);
        }

        // The handshake is checked in the handler, ahead of the upgrade.
        crate::services::websocket_upgrades::serve_upgrades(
            CHAT_PATH,
            Arc::new(|req: Request| Box::pin(Self::handle_upgrade(req))),
        );

        log_info!("WebSocket gateway initialized on /api/ws");
    }

    /// The upgrade handler for `/api/ws`, usable as an `UpgradeHandler` or with
    /// `axum::routing::get`.
    ///
    /// A WebSocket handshake is exempt from the same-origin policy, so the same rules
    /// the HTTP routes get (`lib::origin_guard::is_allowed_origin` on `Origin`, `Host`
    /// and `X-Forwarded-Host`) are applied here. A refused handshake is logged as
    /// `[OriginGuard] refused a WebSocket handshake (origin {}, host {}, x-forwarded-host {})`
    /// and answered `403 Forbidden` with `Connection: close`. An accepted one is
    /// upgraded with a `MAX_FRAME_BYTES` message limit and handed to
    /// `handle_connection` with the sender its headers name.
    pub async fn handle_upgrade(req: Request) -> Response {
        let headers = req.headers();
        let origin = header_of(headers, "origin");
        let host = header_of(headers, "host");
        let forwarded_host = header_of(headers, "x-forwarded-host");
        // A WebSocket handshake is exempt from the same-origin policy, so the
        // same rules the HTTP routes get are applied to it here.
        if !is_allowed_origin(
            origin.as_deref(),
            host.as_deref(),
            forwarded_host.as_deref(),
        ) {
            log_warn!(
                "[OriginGuard] refused a WebSocket handshake (origin {}, host {}, x-forwarded-host {})",
                origin.as_deref().unwrap_or("undefined"),
                host.as_deref().unwrap_or("undefined"),
                forwarded_host.as_deref().unwrap_or("undefined")
            );
            return Response::builder()
                .status(StatusCode::FORBIDDEN)
                .header(http::header::CONNECTION, "close")
                .body(axum::body::Body::empty())
                .expect("a static response builds");
        }

        let sender = sender_of(headers);
        let (mut parts, _body) = req.into_parts();
        let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(upgrade) => upgrade,
            Err(rejection) => return rejection.into_response(),
        };
        upgrade
            .max_message_size(MAX_FRAME_BYTES)
            .max_frame_size(MAX_FRAME_BYTES)
            .on_upgrade(move |socket| WEB_SOCKET_GATEWAY_SERVICE.handle_connection(socket, sender))
    }

    /// A new socket. It may say nothing but `hello` until it is answered, and has
    /// `HELLO_TIMEOUT_MS` to say it.
    ///
    /// Gives it a sends bucket of (10, 20) and a requests bucket of (50, 100), closes
    /// the oldest sockets with `replaced` while `MAX_CONNECTIONS` are open, and logs
    /// `WebSocket connected ({n} connections)`. Then runs the reader: every frame to
    /// `handle_frame`, a pong marks it alive, an error is logged as
    /// `WebSocket error: {message}`. On close: `remove_connection`; a voice start still
    /// opening is marked `disconnected`, a voice session this socket holds is stopped
    /// (`the client disconnected`, `disconnected`; a failure logged as
    /// `Failed to end the voice chat of a disconnected client`); its dictation is
    /// cancelled (`disconnected`); and `WebSocket disconnected - code: {code}` is logged.
    async fn handle_connection(&'static self, socket: WebSocket, sender: Option<ForwardedSender>) {
        let (mut sink, mut stream) = socket.split();
        let (outbound, mut queue) = mpsc::unbounded_channel::<Message>();
        let ws = Arc::new(ChatSocket {
            id: self.next_socket_id.fetch_add(1, Ordering::Relaxed),
            outbound,
            buffered_amount: AtomicUsize::new(0),
            open: AtomicBool::new(true),
            sent_close: Mutex::new(None),
            terminate: CancellationToken::new(),
            is_alive: AtomicBool::new(true),
            ready: AtomicBool::new(false),
            greeting: AtomicBool::new(false),
            sender,
            hello_timer: Mutex::new(None),
            unsubscribe: Mutex::new(None),
            sends: Mutex::new(TokenBucket::new(10.0, 20.0)),
            requests: Mutex::new(TokenBucket::new(50.0, 100.0)),
        });

        // A client that closed a socket and connected again at once has its close frame
        // waiting on the old socket's reader, which may not have run yet. Waiting a moment
        // for those closes to land lets the new socket take the place of the one going
        // away, as Node, which handles events in arrival order, gives it; the oldest live
        // socket is replaced only when every socket is still open after the wait.
        let grace = tokio::time::Instant::now() + Duration::from_millis(CLOSE_GRACE_MS);
        while tokio::time::Instant::now() < grace
            && self
                .connections
                .lock()
                .iter()
                .filter(|socket| socket.open.load(Ordering::SeqCst))
                .count()
                >= MAX_CONNECTIONS
        {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }

        let (replaced, count) = {
            let mut connections = self.connections.lock();
            // A socket already closing leaves the list before the limit is counted, so
            // a client reconnecting at once never pushes out a live socket in its place.
            connections.retain(|socket| socket.open.load(Ordering::SeqCst));
            let mut replaced = Vec::new();
            while connections.len() >= MAX_CONNECTIONS {
                replaced.push(connections.remove(0));
            }
            connections.push(Arc::clone(&ws));
            (replaced, connections.len())
        };
        for oldest in replaced {
            oldest.close(CLOSE_CODES.replaced, "replaced by a newer connection");
        }

        let timer_ws = Arc::clone(&ws);
        let hello_timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(HELLO_TIMEOUT_MS as u64)).await;
            if !timer_ws.ready.load(Ordering::SeqCst) {
                timer_ws.close(CLOSE_CODES.hello_timeout, "no hello");
            }
        });
        *ws.hello_timer.lock() = Some(hello_timer.abort_handle());

        log_info!("WebSocket connected ({} connections)", count);

        // The writer owns the sink: it writes what the gateway queued, in order, and
        // stops after a close frame.
        let writer_ws = Arc::clone(&ws);
        let writer = tokio::spawn(async move {
            loop {
                let next = tokio::select! {
                    _ = writer_ws.terminate.cancelled() => None,
                    next = queue.recv() => next,
                };
                let Some(message) = next else {
                    break;
                };
                let size = message_len(&message);
                let closing = matches!(message, Message::Close(_));
                let written = sink.send(message).await;
                writer_ws.buffered_amount.fetch_sub(
                    size.min(writer_ws.buffered_amount.load(Ordering::SeqCst)),
                    Ordering::SeqCst,
                );
                if written.is_err() || closing {
                    break;
                }
            }
        });

        let mut received_close: Option<Option<CloseFrame>> = None;
        loop {
            let next = tokio::select! {
                _ = ws.terminate.cancelled() => None,
                next = stream.next() => next,
            };
            match next {
                None => break,
                Some(Err(error)) => {
                    log_error!("WebSocket error: {}", error);
                    break;
                }
                Some(Ok(Message::Text(text))) => {
                    self.handle_frame(&ws, Bytes::copy_from_slice(text.as_bytes()), false)
                }
                Some(Ok(Message::Binary(data))) => self.handle_frame(&ws, data, true),
                Some(Ok(Message::Pong(_))) => ws.is_alive.store(true, Ordering::SeqCst),
                Some(Ok(Message::Ping(_))) => {}
                Some(Ok(Message::Close(frame))) => {
                    received_close = Some(frame);
                    break;
                }
            }
        }

        // A close the client started is answered with its own code, as the `ws`
        // server answers it.
        if let Some(frame) = &received_close
            && ws.open.swap(false, Ordering::SeqCst)
        {
            let _ = ws.outbound.send(Message::Close(frame.clone()));
            let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
        }
        ws.terminate();

        let code = match received_close {
            Some(Some(frame)) => frame.code,
            Some(None) => 1005,
            None => ws.sent_close.lock().unwrap_or(1006),
        };
        self.on_close(&ws, code);
    }

    /// What a socket's end does to the gateway's state.
    fn on_close(&'static self, ws: &Arc<ChatSocket>, code: u16) {
        self.remove_connection(ws);
        // The client that was talking is gone, so the call is over: this socket is the
        // only way it could stop the session or hear that it ended.
        let still_opening = {
            let mut starting = self.voice_starting.lock();
            match starting.as_mut() {
                Some(starting) if Arc::ptr_eq(&starting.ws, ws) => {
                    // Still opening. `handle_voice_start` ends it once the start
                    // returns, since only it knows whether there is a session to end yet.
                    starting.cancelled = Some(VoiceChatEndStatus::Disconnected);
                    true
                }
                _ => false,
            }
        };
        if !still_opening {
            let held = {
                let mut voice_socket = self.voice_socket.lock();
                if voice_socket
                    .as_ref()
                    .is_some_and(|holder| Arc::ptr_eq(holder, ws))
                {
                    *voice_socket = None;
                    true
                } else {
                    false
                }
            };
            if held {
                // Reported rather than dropped — this is the path that frees the
                // runtime's one voice, and a failure here is a runtime that cannot take
                // another call.
                tokio::spawn(async {
                    if let Err(err) = VOICE_CHAT_SERVICE
                        .stop(
                            Some("the client disconnected"),
                            Some(VoiceChatEndStatus::Disconnected),
                        )
                        .await
                    {
                        log_error!(
                            json!({ "err": err_json(&err) }),
                            "Failed to end the voice chat of a disconnected client"
                        );
                    }
                });
            }
        }
        let dictation = self.dictations.lock().get(&ws.id).cloned();
        if let Some(dictation) = dictation {
            dictation.cancel(DictationCancelReason::Disconnected);
        }
        log_info!("WebSocket disconnected - code: {}", code);
    }

    /// One frame from a socket.
    ///
    /// Audio first, and never parsed: a binary frame is one frame of the client's
    /// microphone, handled by `handle_binary` once the socket is ready. A text frame
    /// that is not JSON is answered `nack` `invalid` `A frame must be JSON.`. Before
    /// `welcome` only `hello` is read, and a frame that arrives while a `hello` is being
    /// answered is answered `invalid` `Wait for welcome before sending anything else.`.
    /// After it, a frame that is not a `ClientFrame` is answered `invalid` with the
    /// first validation issue's message, a frame over its bucket is answered
    /// `rate_limited` `Too many requests.` with `retryAfterMs`, and the rest go to
    /// `dispatch`.
    ///
    /// Frames are read in order; what a request waits for runs on a task of its own,
    /// so a slow request does not hold the frames after it.
    fn handle_frame(&'static self, ws: &Arc<ChatSocket>, data: Bytes, is_binary: bool) {
        // Audio first, and never parsed. A binary frame is one frame of the client's
        // microphone; parsing it as JSON would fail on every one of them fifty times a
        // second and answer each with an error.
        if is_binary {
            if ws.ready.load(Ordering::SeqCst) {
                self.handle_binary(ws, data);
            }
            return;
        }

        let raw: Value = match serde_json::from_slice(&data) {
            Ok(raw) => raw,
            Err(_) => {
                self.nack(ws, None, NackCode::Invalid, "A frame must be JSON.");
                return;
            }
        };

        if !ws.ready.load(Ordering::SeqCst) {
            // The answer to `hello` reads the database, and a client may send again
            // before it arrives. That frame is refused, not taken as a second `hello`:
            // two would subscribe the socket twice.
            if ws.greeting.load(Ordering::SeqCst) {
                self.nack(
                    ws,
                    request_id_of(&raw).as_deref(),
                    NackCode::Invalid,
                    "Wait for welcome before sending anything else.",
                );
                return;
            }
            self.handle_hello(ws, raw);
            return;
        }

        let frame = match parse_client_frame(&raw) {
            Ok(frame) => frame,
            Err(message) => {
                self.nack(
                    ws,
                    request_id_of(&raw).as_deref(),
                    NackCode::Invalid,
                    &message,
                );
                return;
            }
        };

        let wait = match &frame {
            ClientFrame::Send(_) => ws.sends.lock().take(),
            _ => ws.requests.lock().take(),
        };
        if wait > 0 {
            self.send_to(
                ws,
                &DirectFrame::Nack {
                    re: Some(frame.id().to_string()),
                    payload: NackPayload {
                        code: NackCode::RateLimited,
                        message: "Too many requests.".to_string(),
                        retry_after_ms: Some(wait),
                    },
                },
            );
            return;
        }

        self.dispatch(ws, frame);
    }

    /// Answer `hello`: the version check, the resume and the `welcome`.
    ///
    /// The snapshot is read first, because the desktop's state needs the database.
    /// Everything after it — the `welcome`, the replay and joining the live stream —
    /// runs with the stream held, so no event can fall between the replay and the first
    /// live one. An event published while the snapshot was read is in the replay, or
    /// newer than a `welcome` that did not resume; either way the client applies it
    /// after the snapshot, and every event is an upsert or a full state.
    ///
    /// A `hello` that does not parse or names another protocol is answered
    /// `protocol_unsupported`
    /// `This runtime speaks chat protocol {PROTOCOL_VERSION}. Update the app to connect.`
    /// and closed with `protocolUnsupported`. A resume emits `chat socket resumed`
    /// (`socket.outcome` `resumed` or `resync`, `socket.replayed`, `socket.client`).
    fn handle_hello(&'static self, ws: &Arc<ChatSocket>, raw: Value) {
        let hello = match parse_hello_frame(&raw) {
            Ok(hello) if hello.payload.protocol == PROTOCOL_VERSION => hello,
            _ => {
                self.nack(
                    ws,
                    request_id_of(&raw).as_deref(),
                    NackCode::ProtocolUnsupported,
                    &format!(
                        "This runtime speaks chat protocol {PROTOCOL_VERSION}. Update the app to connect."
                    ),
                );
                ws.close(CLOSE_CODES.protocol_unsupported, "protocol unsupported");
                return;
            }
        };
        if let Some(timer) = ws.hello_timer.lock().take() {
            timer.abort();
        }
        ws.greeting.store(true, Ordering::SeqCst);

        let ws = Arc::clone(ws);
        tokio::spawn(async move {
            let computer = self.computer_state().await;
            if !ws.is_open() {
                return;
            }

            let resume = hello.payload.resume.clone();
            let replayed = EVENT_STREAM_SERVICE.exclusive(|| {
                let replay = resume.as_ref().and_then(|resume| {
                    EVENT_STREAM_SERVICE.replay_after(&resume.stream_id, resume.seq)
                });
                let turns = INBOUND_MESSAGE_SERVICE
                    .turns()
                    .into_iter()
                    .map(|turn| SnapshotTurn {
                        thread_id: turn.thread_id,
                        state: turn.state,
                    })
                    .collect();
                self.send_to(
                    &ws,
                    &DirectFrame::Welcome {
                        payload: WelcomePayload {
                            protocol: PROTOCOL_VERSION,
                            stream_id: EVENT_STREAM_SERVICE.stream_id(),
                            seq: EVENT_STREAM_SERVICE.seq(),
                            resumed: replay.is_some(),
                            you: WelcomeYou {
                                id: ws.sender.as_ref().map(|s| s.id.clone()),
                                name: ws.sender.as_ref().map(|s| s.name.clone()),
                            },
                            thread_mode: CONFIG.thread_mode,
                            snapshot: WelcomeSnapshot { turns, computer },
                        },
                    },
                );
                for entry in replay.iter().flatten() {
                    self.send_entry(&ws, entry);
                }
                let subscriber = Arc::clone(&ws);
                *ws.unsubscribe.lock() = Some(EVENT_STREAM_SERVICE.subscribe(Arc::new(
                    move |entry: &StreamEntry| {
                        WEB_SOCKET_GATEWAY_SERVICE.send_entry(&subscriber, entry)
                    },
                )));
                ws.ready.store(true, Ordering::SeqCst);
                ws.greeting.store(false, Ordering::SeqCst);
                replay.map(|entries| entries.len())
            });
            // A socket that closed while it was greeted has been forgotten already, and
            // must not stay subscribed.
            if !ws.is_open()
                && let Some(unsubscribe) = ws.unsubscribe.lock().take()
            {
                unsubscribe();
            }

            if resume.is_some() {
                let mut props = IndexMap::new();
                if let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) {
                    props.insert("agent.id".to_string(), agent_id);
                }
                props.insert(
                    "socket.outcome".to_string(),
                    if replayed.is_some() {
                        "resumed"
                    } else {
                        "resync"
                    }
                    .to_string(),
                );
                props.insert(
                    "socket.replayed".to_string(),
                    replayed.unwrap_or(0).to_string(),
                );
                props.insert(
                    "socket.client".to_string(),
                    hello.payload.client.name.clone(),
                );
                track_event(
                    "chat socket resumed",
                    Some(&CONFIG.owner_user_id()),
                    Some(props),
                );
            }
        });
    }

    /// Route a validated request: `ping` → `pong`; `send` → `handle_send`; `cancel` →
    /// `INBOUND_MESSAGE_SERVICE.cancel` answered `ack` `{}` or `nack` with an
    /// `InboundMessageError`'s code and message; the voice and dictation requests to
    /// their handlers, all as the owner user. A request that fails otherwise is
    /// logged as `WebSocket frame error: {message}`.
    fn dispatch(&'static self, ws: &Arc<ChatSocket>, frame: ClientFrame) {
        let ws = Arc::clone(ws);
        match frame {
            ClientFrame::Ping(frame) => self.send_to(&ws, &DirectFrame::Pong { re: frame.id }),

            ClientFrame::Send(frame) => {
                let message = frame.payload.message;
                tokio::spawn(async move {
                    self.handle_send(
                        &ws,
                        &frame.id,
                        SentMessage {
                            id: message.id,
                            thread_id: message.thread_id,
                            content: message.content,
                            attachment_ids: message.attachment_ids,
                        },
                    )
                    .await
                });
            }

            ClientFrame::Cancel(frame) => {
                tokio::spawn(async move {
                    match INBOUND_MESSAGE_SERVICE
                        .cancel(&frame.payload.thread_id)
                        .await
                    {
                        Ok(_) => self.send_to(
                            &ws,
                            &DirectFrame::Ack {
                                re: frame.id,
                                payload: AckPayload::Empty {},
                            },
                        ),
                        Err(error) => match error.downcast_ref::<InboundMessageError>() {
                            Some(refusal) => {
                                self.nack(&ws, Some(&frame.id), refusal.code, &refusal.message)
                            }
                            None => log_error!("WebSocket frame error: {}", error),
                        },
                    }
                });
            }

            // Voice control. The audio itself rides this socket too, as binary frames
            // handled before the JSON path — see `handle_binary`.
            ClientFrame::VoiceStart(frame) => {
                self.handle_voice_start(&ws, &CONFIG.owner_user_id(), &frame.payload)
            }

            ClientFrame::VoiceStop(_) => {
                tokio::spawn(async move { self.handle_voice_stop(&ws).await });
            }

            ClientFrame::DictationStart(_) => {
                self.handle_dictation_start(&ws, &CONFIG.owner_user_id())
            }

            ClientFrame::DictationStop(frame) => {
                self.handle_dictation_stop(&ws, frame.payload.commit)
            }
        }
    }

    /// Store the message and confirm it (`ack` with `messageId`, `seq`, `queued`,
    /// `duplicate`), or say why not: an `InboundMessageError` is answered with its own
    /// code and message, anything else is logged as
    /// `Could not accept message {id}: {message}` and answered `failed`
    /// `The message could not be saved. Try again.`.
    async fn handle_send(&self, ws: &Arc<ChatSocket>, re: &str, message: SentMessage) {
        let id = message.id.clone();
        let accepted = INBOUND_MESSAGE_SERVICE
            .accept(InboundMessage {
                id: message.id,
                thread_id: message.thread_id,
                content: message.content,
                attachment_ids: message.attachment_ids,
                sender: ws.sender.as_ref().map(|sender| InboundSender {
                    id: sender.id.clone(),
                    name: sender.name.clone(),
                }),
                agent_message: None,
                runtime_written: false,
            })
            .await;
        match accepted {
            Ok(accepted) => self.send_to(
                ws,
                &DirectFrame::Ack {
                    re: re.to_string(),
                    payload: AckPayload::Send(SendAckPayload {
                        message_id: accepted.message.id,
                        seq: accepted.seq,
                        queued: accepted.queued,
                        duplicate: accepted.duplicate,
                    }),
                },
            ),
            Err(error) => {
                if let Some(refusal) = error.downcast_ref::<InboundMessageError>() {
                    self.nack(ws, Some(re), refusal.code, &refusal.message);
                    return;
                }
                log_error!("Could not accept message {}: {}", id, error);
                self.nack(
                    ws,
                    Some(re),
                    NackCode::Failed,
                    "The message could not be saved. Try again.",
                );
            }
        }
    }

    fn nack(&self, ws: &Arc<ChatSocket>, re: Option<&str>, code: NackCode, message: &str) {
        self.send_to(
            ws,
            &DirectFrame::Nack {
                re: re.map(str::to_string),
                payload: NackPayload {
                    code,
                    message: message.to_string(),
                    retry_after_ms: None,
                },
            },
        );
    }

    /// One stream event, to one socket. A socket more than `MAX_BUFFERED_BYTES`
    /// behind is closed (`slowConsumer`, `too far behind`, logged as
    /// `Closing a chat socket {n} bytes behind`) rather than queued to: it resumes
    /// from the replay window on reconnect.
    fn send_entry(&self, ws: &Arc<ChatSocket>, entry: &StreamEntry) {
        if !ws.is_open() {
            return;
        }
        let buffered = ws.buffered_amount.load(Ordering::SeqCst);
        if buffered > MAX_BUFFERED_BYTES {
            log_warn!("Closing a chat socket {} bytes behind", buffered);
            ws.close(CLOSE_CODES.slow_consumer, "too far behind");
            return;
        }
        ws.send_text(entry.frame.clone());
    }

    /// Open a voice chat for the client on this socket.
    ///
    /// The session belongs to the runtime rather than to the socket, so a request that
    /// arrives while one is running is refused with a `voice_error` and leaves the call
    /// alone. That refusal is the gateway's own rather than the voice service's, because
    /// the socket is claimed before the service is asked — a second request allowed
    /// through would take the running call's audio path with it.
    ///
    /// Refusals, in order: no agent (`Agent runtime is still initializing; retry
    /// shortly`), an unsupported mode (`mode must be "open" or "addressed"`), a
    /// dictation on this socket (`A dictation is running on this connection. Finish it
    /// first.`), a voice socket already taken (`A voice chat is already running on this
    /// connection. Stop it first.` for this socket, else `There is already a voice chat
    /// running. End that one first.`). A start whose client left meanwhile is stopped
    /// (`the client left before the call started`); a live one is answered
    /// `voice_hello` with the session's sample rate.
    fn handle_voice_start(
        &'static self,
        ws: &Arc<ChatSocket>,
        user_id: &str,
        payload: &Map<String, Value>,
    ) {
        let voice_error = |error: &str| {
            self.send_to(
                ws,
                &DirectFrame::VoiceError {
                    payload: json!({ "error": error }),
                },
            )
        };
        let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) else {
            voice_error("Agent runtime is still initializing; retry shortly");
            return;
        };

        let mode = match listening_mode(payload) {
            ListeningModeRequest::Unsupported => {
                voice_error("mode must be \"open\" or \"addressed\"");
                return;
            }
            ListeningModeRequest::Unset => None,
            ListeningModeRequest::Mode(mode) => Some(mode),
        };

        // The socket's binary frames are one microphone, so they can feed one session.
        if self.dictations.lock().contains_key(&ws.id) {
            voice_error("A dictation is running on this connection. Finish it first.");
            return;
        }

        // Two different situations and two different things for the user to do: end the
        // call on this connection, or find whoever is on the other one. Claimed before
        // the service is asked, for two reasons. The service reports `live` from inside
        // `start()`, so the client can be sending audio while this is still waiting, and
        // `handle_binary` drops every frame from a socket that is not this one. And it is
        // what refuses a second request here, so only one start is ever outstanding and
        // one cancel record is enough for it.
        {
            let mut voice_socket = self.voice_socket.lock();
            if let Some(holder) = voice_socket.as_ref() {
                let error = if Arc::ptr_eq(holder, ws) {
                    "A voice chat is already running on this connection. Stop it first."
                } else {
                    "There is already a voice chat running. End that one first."
                };
                drop(voice_socket);
                voice_error(error);
                return;
            }
            *voice_socket = Some(Arc::clone(ws));
        }
        *self.voice_starting.lock() = Some(VoiceStarting {
            ws: Arc::clone(ws),
            cancelled: None,
        });

        // A session with a computer opens a browser and a desktop for the agent, which
        // the client then watches on a transport of its own; see `computer_endpoint.rs`.
        let computer = payload.get("computer") == Some(&Value::Bool(true));
        let input = StartVoiceChatInput {
            user_id: user_id.to_string(),
            agent_id,
            thread_id: string_field(payload, "threadId"),
            mode,
            signal: self.voice_signal(ws),
            surface: Some(if computer {
                VoiceChatSurface::Computer
            } else {
                VoiceChatSurface::Chat
            }),
            computer,
            sample_rate: computer.then_some(MEETING_SAMPLE_RATE),
            screen: screen_of(payload).map(|screen| ScreenRect {
                width: screen.width as i64,
                height: screen.height as i64,
            }),
            greeting: string_field(payload, "greeting"),
        };
        let ws = Arc::clone(ws);
        tokio::spawn(async move {
            let started = VOICE_CHAT_SERVICE.start(input).await;

            let cancelled = {
                let mut starting = self.voice_starting.lock();
                match starting.as_ref() {
                    Some(record) if Arc::ptr_eq(&record.ws, &ws) => {
                        let cancelled = record.cancelled;
                        *starting = None;
                        cancelled
                    }
                    _ => None,
                }
            };
            // The claim only survives a session this socket still holds. A refused start,
            // a client that gave up and a client that went away all give it back, or the
            // field would name a socket with no session and refuse every later call.
            let holds = started && cancelled.is_none() && ws.is_open();
            if !holds {
                let mut voice_socket = self.voice_socket.lock();
                if voice_socket
                    .as_ref()
                    .is_some_and(|holder| Arc::ptr_eq(holder, &ws))
                {
                    *voice_socket = None;
                }
            }

            if !started {
                return;
            }

            // Nobody is on the other end of the session that just opened, so end it here:
            // it would otherwise hold the agent's voice, and the runtime's one voice with
            // it, until something else ended the call.
            if cancelled.is_some() || !ws.is_open() {
                // A socket already gone when the answer arrives dropped, whether or not
                // its close was the thing that cancelled this.
                if let Err(error) = VOICE_CHAT_SERVICE
                    .stop(
                        Some("the client left before the call started"),
                        Some(cancelled.unwrap_or(VoiceChatEndStatus::Disconnected)),
                    )
                    .await
                {
                    log_error!("WebSocket frame error: {}", error);
                }
                return;
            }

            // The rate the session was built at, which a computer raises so the sound of
            // its desktop reaches the client unresampled. The client opens its microphone
            // and its playback at whatever this says.
            self.send_to(
                &ws,
                &DirectFrame::VoiceHello {
                    payload: json!({
                        "format": {
                            "encoding": VOICE_AUDIO_FORMAT.encoding,
                            "sampleRate": VOICE_CHAT_SERVICE.sample_rate(),
                            "channels": VOICE_AUDIO_FORMAT.channels,
                        }
                    }),
                },
            );
        });
    }

    /// One frame of the client's microphone: to the socket's dictation, else to the
    /// voice session when this socket holds it.
    ///
    /// Another client's audio is not this call's, and a frame arriving after a call
    /// ended is ordinary rather than an error, so both are dropped in silence.
    fn handle_binary(&self, ws: &Arc<ChatSocket>, data: Bytes) {
        let dictation = self.dictations.lock().get(&ws.id).cloned();
        if let Some(dictation) = dictation {
            dictation.push_audio(&data);
            return;
        }
        let holds = self
            .voice_socket
            .lock()
            .as_ref()
            .is_some_and(|holder| Arc::ptr_eq(holder, ws));
        if !holds {
            return;
        }
        VOICE_CHAT_SERVICE.push_audio(data);
    }

    /// End the session this socket opened. A stop from any other socket does nothing;
    /// a stop while the start is still opening marks it `completed`.
    async fn handle_voice_stop(&self, ws: &Arc<ChatSocket>) {
        {
            let mut starting = self.voice_starting.lock();
            if let Some(record) = starting
                .as_mut()
                .filter(|record| Arc::ptr_eq(&record.ws, ws))
            {
                // Still opening, so there is nothing to end yet. `handle_voice_start` ends
                // it once the start returns, and reads this as the client having asked.
                record.cancelled = Some(VoiceChatEndStatus::Completed);
                return;
            }
        }
        let holds = self
            .voice_socket
            .lock()
            .as_ref()
            .is_some_and(|holder| Arc::ptr_eq(holder, ws));
        if !holds {
            return;
        }
        if let Err(error) = VOICE_CHAT_SERVICE.stop(None, None).await {
            log_error!("WebSocket frame error: {}", error);
        }
    }

    /// How the voice service answers the client that asked for the session.
    fn voice_signal(&self, ws: &Arc<ChatSocket>) -> Arc<SocketVoiceSignal> {
        Arc::new(SocketVoiceSignal {
            ws: ws.clone(),
            dropping: AtomicBool::new(false),
        })
    }

    /// Start a dictation for the client on this socket.
    ///
    /// Registered before the upstream answers, so the audio the client streams from the
    /// moment the user presses is kept rather than dropped, and a stop that arrives
    /// while the session connects is honoured once it is ready. Refused with a
    /// `dictation_error`: `A dictation is already running on this connection.`, `A voice
    /// chat is running on this connection. End it first.`, or (no Realtime endpoint)
    /// `Dictation needs a managed voice provider for this agent.`.
    fn handle_dictation_start(&'static self, ws: &Arc<ChatSocket>, user_id: &str) {
        let voice_here = self
            .voice_socket
            .lock()
            .as_ref()
            .is_some_and(|holder| Arc::ptr_eq(holder, ws))
            || self
                .voice_starting
                .lock()
                .as_ref()
                .is_some_and(|record| Arc::ptr_eq(&record.ws, ws));
        let refusal = if self.dictations.lock().contains_key(&ws.id) {
            Some("A dictation is already running on this connection.")
        } else if voice_here {
            Some("A voice chat is running on this connection. End it first.")
        } else if !is_realtime_configured() {
            Some("Dictation needs a managed voice provider for this agent.")
        } else {
            None
        };
        if let Some(refusal) = refusal {
            self.send_to(
                ws,
                &DirectFrame::DictationError {
                    payload: json!({ "error": refusal }),
                },
            );
            return;
        }

        let this_session: Arc<Mutex<Weak<DictationSession>>> = Arc::new(Mutex::new(Weak::new()));
        let socket_id = ws.id;
        let on_end = {
            let this_session = Arc::clone(&this_session);
            Arc::new(move || {
                let mut dictations = WEB_SOCKET_GATEWAY_SERVICE.dictations.lock();
                let current = this_session.lock().clone();
                if dictations
                    .get(&socket_id)
                    .is_some_and(|session| Weak::ptr_eq(&Arc::downgrade(session), &current))
                {
                    dictations.remove(&socket_id);
                }
            })
        };
        let session = DictationSession::new(DictationSessionOptions {
            user_id: user_id.to_string(),
            signal: Arc::new(SocketDictationSignal { ws: Arc::clone(ws) }),
            on_end: Some(on_end),
            endpoint_override: None,
            max_audio_ms: None,
            connect_timeout_ms: None,
            result_timeout_ms: None,
        });
        *this_session.lock() = Arc::downgrade(&session);
        self.dictations.lock().insert(ws.id, Arc::clone(&session));
        tokio::spawn(async move {
            session.start().await;
        });
    }

    /// Transcribe or drop this socket's dictation (`commit == Some(false)` drops it). A
    /// stop with nothing recording does nothing.
    fn handle_dictation_stop(&self, ws: &Arc<ChatSocket>, commit: Option<bool>) {
        let Some(session) = self.dictations.lock().get(&ws.id).cloned() else {
            return;
        };
        if commit == Some(false) {
            session.cancel(DictationCancelReason::Cancelled);
            return;
        }
        session.commit();
    }

    /// Send to one socket, which the client may have closed under us.
    fn send_to(&self, ws: &Arc<ChatSocket>, response: &DirectFrame) {
        if !ws.is_open() {
            return;
        }
        ws.send_text(serde_json::to_string(response).expect("a direct frame serializes"));
    }

    /// Forget a socket, and stop sending it the stream.
    fn remove_connection(&self, ws: &Arc<ChatSocket>) {
        if let Some(timer) = ws.hello_timer.lock().take() {
            timer.abort();
        }
        if let Some(unsubscribe) = ws.unsubscribe.lock().take() {
            unsubscribe();
        }
        self.connections
            .lock()
            .retain(|socket| !Arc::ptr_eq(socket, ws));
    }

    /// Close all connections (for shutdown): each open socket with `1001`
    /// `Server shutting down`, every subscription stopped, the list emptied.
    pub fn close_all(&self) {
        let sockets = std::mem::take(&mut *self.connections.lock());
        for ws in sockets {
            ws.close(1001, "Server shutting down");
            if let Some(unsubscribe) = ws.unsubscribe.lock().take() {
                unsubscribe();
            }
        }
    }
}

pub static WEB_SOCKET_GATEWAY_SERVICE: LazyLock<WebSocketGatewayService> =
    LazyLock::new(WebSocketGatewayService::new);

#[cfg(test)]
mod tests;
