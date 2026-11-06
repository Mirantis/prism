//! Live desktop video, audio, and user input on a separate WebSocket. `?computer=` names
//! the computer to watch, the runtime's own when absent.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};

use axum::extract::Request;
use axum::extract::ws::{Message, WebSocket};
use axum::response::Response;
use bytes::{BufMut, Bytes, BytesMut};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::computer_service::ComputerConnection;
use super::computer_session::{ComputerSession, ComputerViewer, SessionStatus};
use super::picture_stream::{ScreenFrame, StreamEncoding};

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
        todo!()
    }

    fn audio(&self, pcm: Bytes) {
        todo!()
    }
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
        todo!()
    }

    /// One upgrade to `COMPUTER_PATH`. A WebSocket handshake is exempt from the same-origin
    /// policy, so the rules the HTTP routes and `/api/ws` get are applied to it here: a
    /// refused origin answers 403, and a computer that does not exist 404.
    pub async fn handle_upgrade(&'static self, req: Request) -> Response {
        todo!()
    }

    /// Serve one viewer of `session`: its state on every change, its frames to the session
    /// or to the voice call's recording, and the screen while it is attached.
    async fn serve(&'static self, ws: WebSocket, session: Arc<ComputerSession>) {
        todo!()
    }

    /// Stop taking connections; called from the process shutdown path. Closes every socket
    /// with 1001.
    pub fn close(&self) {
        todo!()
    }
}

impl Default for ComputerEndpoint {
    fn default() -> Self {
        ComputerEndpoint::new()
    }
}

/// One JSON frame to a socket, while it is open.
fn send(socket: &ViewerSocket, frame: &ComputerFrame) {
    todo!()
}
