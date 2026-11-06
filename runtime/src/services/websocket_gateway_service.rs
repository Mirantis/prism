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
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

use axum::extract::Request;
use axum::extract::ws::{Message, WebSocket};
use axum::response::Response;
use bytes::Bytes;
use http::HeaderMap;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tokio::task::{AbortHandle, JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::lib::token_bucket::TokenBucket;
use crate::protocol::chat_protocol::{ClientFrame, DirectFrame, NackCode};
use crate::services::event_stream_service::StreamEntry;
use crate::services::voice::dictation_session::DictationSession;
use crate::services::voice::socket_audio::VOICE_AUDIO_FORMAT;
use crate::services::voice::voice_chat_service::{VoiceChatEndStatus, VoiceListeningMode};
use crate::support::js;

/// Where the Web UI's chat and its voice connect. The screen has its own path; see
/// `services/computer/computer_endpoint.rs`.
pub const CHAT_PATH: &str = "/api/ws";

/// How many sockets the agent keeps at once. A newer one replaces the oldest
/// rather than being refused: the oldest is usually a phone's socket that died
/// behind a locked screen and has not been noticed yet, and refusing the phone's
/// fresh one would lock its owner out until the heartbeat caught up.
pub const MAX_CONNECTIONS: usize = 16;

/// How much may sit unsent on one socket before the gateway stops trying. A
/// client that far behind is closed and resumes from the replay window, which
/// costs the server nothing, instead of growing a queue in its memory.
pub const MAX_BUFFERED_BYTES: usize = 4 * 1024 * 1024;

/// The most code points kept from each ingress header value.
const MAX_SENDER_CHARS: usize = 128;

/// The headers the Lens Agents ingress names the signed-in caller in. It strips any
/// copy a client sent, and omits the id and the display name when it has none.
const FORWARDED_USER_HEADER: &str = "x-forwarded-user";
const FORWARDED_USER_ID_HEADER: &str = "x-forwarded-user-id";
const FORWARDED_USER_DISPLAY_NAME_HEADER: &str = "x-forwarded-user-display-name";

/// How often the protocol-level heartbeat pings every socket, terminating one that
/// did not answer the previous ping.
const HEARTBEAT_INTERVAL_MS: u64 = 30_000;

/// How much of the agent's speech may sit unsent on a socket before frames are dropped.
///
/// Two seconds at the one rate the protocol carries. A client that cannot keep up is
/// behind on the conversation, not merely behind on the audio: what is queued is already
/// stale by the time it plays, and the queue grows for as long as the call runs. Dropping
/// keeps the delay bounded, which is what a media transport would have done here.
const MAX_BUFFERED_AUDIO_BYTES: usize = VOICE_AUDIO_FORMAT.sample_rate as usize * 2 * 2;

static SENDER_UNSAFE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[<>:\x00-\x1f\x7f]").expect("valid regex"));

/// Who the ingress says is on a connection. Display and attribution only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatSender {
    pub id: String,
    pub name: String,
}

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
    /// Ends the reader and the writer at once, without a close handshake
    /// (`ws.terminate()`).
    terminate: CancellationToken,
    is_alive: AtomicBool,
    /// Set once the socket said `hello` and was answered. Nothing else is read before.
    ready: AtomicBool,
    /// Set while a `hello` is being answered, so a second one cannot start another.
    greeting: AtomicBool,
    /// Who the ingress says is on this connection. Display and attribution only.
    sender: Option<ChatSender>,
    hello_timer: Mutex<Option<AbortHandle>>,
    /// Stops this socket's stream subscription.
    unsubscribe: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// A send is the expensive request; everything else is cheap.
    sends: Mutex<TokenBucket>,
    requests: Mutex<TokenBucket>,
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

/// How a dictation answers its socket: `dictation_hello` with the audio format when
/// ready, `dictation_delta`, `dictation_result` and `dictation_error`.
struct SocketDictationSignal {
    ws: Arc<ChatSocket>,
}

/// One header value, or `None` when the header is absent. Repeated headers read as
/// Node joins them, with `, `.
fn header_of(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
        .collect();
    if values.is_empty() {
        None
    } else {
        Some(values.join(", "))
    }
}

/// `String.prototype.trim`: JavaScript's white space and line terminators.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// A header value made safe to show: no angle brackets, colons or control characters, and capped.
fn clean_sender(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    let cleaned = SENDER_UNSAFE.replace_all(value, "");
    let capped: String = js_trim(&cleaned).chars().take(MAX_SENDER_CHARS).collect();
    (!capped.is_empty()).then_some(capped)
}

/// `decodeURIComponent`: `None` for a malformed escape or bytes that are not UTF-8.
fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = value.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The display name header, which the ingress always percent-encodes.
fn decoded_display_name(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    clean_sender(Some(&decode_uri_component(value)?))
}

/// Who is on this connection, from the ingress's headers. The id is the signed-in
/// person's user id. The name is their display name. Each falls back to
/// `x-forwarded-user`, the person's email or user id, when the ingress omits it.
///
/// **Attribution and display only.** The ingress writes the headers for a private
/// port after it signed the caller in, and strips any copy a client sent. A
/// runtime reached some other way — local development, or bound wider on purpose
/// — would read whatever a client wrote, so nothing is ever decided on them.
fn sender_of(headers: &HeaderMap) -> Option<ChatSender> {
    let legacy = clean_sender(header_of(headers, FORWARDED_USER_HEADER).as_deref());
    let id = clean_sender(header_of(headers, FORWARDED_USER_ID_HEADER).as_deref())
        .or_else(|| legacy.clone())?;
    let name =
        decoded_display_name(header_of(headers, FORWARDED_USER_DISPLAY_NAME_HEADER).as_deref())
            .or(legacy)
            .unwrap_or_else(|| id.clone());
    Some(ChatSender { id, name })
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
        todo!()
    }

    /// Publish the state of the desktop, coalescing a burst of changes into one event.
    ///
    /// The payload needs a database read, and one call on the access gate emits twice —
    /// a turn taking a free desktop is queued and then holds it — so the first build
    /// waits for the current tick to finish (`tokio::task::yield_now`), and a change
    /// that lands during a build schedules exactly one more.
    async fn publish_computer(&self) {
        todo!()
    }

    /// The runtime's own desktop as `GET /computers/local` reads it, every help request
    /// (`help`), and the list of computers (`computers`); or `None` while no agent is
    /// loaded. A failed build is logged (`[Computer] Could not read the computer state`)
    /// and answered with `None`: the next change corrects every client.
    async fn computer_state(&self) -> Option<Map<String, Value>> {
        todo!()
    }

    /// Start serving the chat socket: register [`Self::handle_upgrade`] for
    /// `/api/ws` with `websocket_upgrades::serve_upgrades`, subscribe to the other
    /// services' events, and start the 30-second heartbeat that pings every socket
    /// and terminates one whose last ping went unanswered. Logs
    /// `WebSocket gateway initialized on /api/ws`.
    pub fn initialize(&'static self) {
        todo!()
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
        todo!()
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
    async fn handle_connection(&'static self, socket: WebSocket, sender: Option<ChatSender>) {
        todo!()
    }

    /// One frame from a socket.
    ///
    /// Audio first, and never parsed: a binary frame is one frame of the client's
    /// microphone, handled by `handle_binary` once the socket is ready. A text frame
    /// that is not JSON is answered `nack` `invalid` `A frame must be JSON.`. Before
    /// `welcome` only `hello` is read, and a frame that arrives while a `hello` is being
    /// answered is answered `invalid` `Wait for welcome before sending anything else.`.
    /// After it, a frame that is not a `ClientFrame` is answered `invalid` with the
    /// first validation issue's message (else `Unreadable request.`), a frame over its
    /// bucket is answered `rate_limited` `Too many requests.` with `retryAfterMs`, and
    /// the rest go to `dispatch`. Errors are logged as `WebSocket frame error: {message}`.
    async fn handle_frame(&'static self, ws: &Arc<ChatSocket>, data: Bytes, is_binary: bool) {
        todo!()
    }

    /// Answer `hello`: the version check, the resume and the `welcome`.
    ///
    /// The snapshot is read first, because the desktop's state needs the database.
    /// Everything after it — the `welcome`, the replay and joining the live stream —
    /// runs without an await, so no event can fall between the replay and the first
    /// live one. An event published while the snapshot was read is in the replay, or
    /// newer than a `welcome` that did not resume; either way the client applies it
    /// after the snapshot, and every event is an upsert or a full state.
    ///
    /// A `hello` that does not parse or names another protocol is answered
    /// `protocol_unsupported`
    /// `This runtime speaks chat protocol {PROTOCOL_VERSION}. Update the app to connect.`
    /// and closed with `protocolUnsupported`. A resume emits `chat socket resumed`
    /// (`socket.outcome` `resumed` or `resync`, `socket.replayed`, `socket.client`).
    async fn handle_hello(&self, ws: &Arc<ChatSocket>, raw: Value) {
        todo!()
    }

    /// Route a validated request: `ping` → `pong`; `send` → `handle_send`; `cancel` →
    /// `INBOUND_MESSAGE_SERVICE.cancel` answered `ack` `{}` or `nack` with an
    /// `InboundMessageError`'s code and message; the voice and dictation requests to
    /// their handlers, all as the owner user.
    async fn dispatch(&'static self, ws: &Arc<ChatSocket>, frame: ClientFrame) {
        todo!()
    }

    /// Store the message and confirm it (`ack` with `messageId`, `seq`, `queued`,
    /// `duplicate`), or say why not: an `InboundMessageError` is answered with its own
    /// code and message, anything else is logged as
    /// `Could not accept message {id}: {message}` and answered `failed`
    /// `The message could not be saved. Try again.`.
    async fn handle_send(&self, ws: &Arc<ChatSocket>, re: &str, message: SentMessage) {
        todo!()
    }

    fn nack(&self, ws: &Arc<ChatSocket>, re: Option<&str>, code: NackCode, message: &str) {
        todo!()
    }

    /// One stream event, to one socket. A socket more than `MAX_BUFFERED_BYTES`
    /// behind is closed (`slowConsumer`, `too far behind`, logged as
    /// `Closing a chat socket {n} bytes behind`) rather than queued to: it resumes
    /// from the replay window on reconnect.
    fn send_entry(&self, ws: &Arc<ChatSocket>, entry: &StreamEntry) {
        todo!()
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
    async fn handle_voice_start(
        &self,
        ws: &Arc<ChatSocket>,
        user_id: &str,
        payload: &Map<String, Value>,
    ) {
        todo!()
    }

    /// One frame of the client's microphone: to the socket's dictation, else to the
    /// voice session when this socket holds it.
    ///
    /// Another client's audio is not this call's, and a frame arriving after a call
    /// ended is ordinary rather than an error, so both are dropped in silence.
    fn handle_binary(&self, ws: &Arc<ChatSocket>, data: Bytes) {
        todo!()
    }

    /// End the session this socket opened. A stop from any other socket does nothing;
    /// a stop while the start is still opening marks it `completed`.
    async fn handle_voice_stop(&self, ws: &Arc<ChatSocket>) {
        todo!()
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
    async fn handle_dictation_start(&self, ws: &Arc<ChatSocket>, user_id: &str) {
        todo!()
    }

    /// Transcribe or drop this socket's dictation (`commit == Some(false)` drops it). A
    /// stop with nothing recording does nothing.
    fn handle_dictation_stop(&self, ws: &Arc<ChatSocket>, commit: Option<bool>) {
        todo!()
    }

    /// Send to one socket, which the client may have closed under us.
    fn send_to(&self, ws: &Arc<ChatSocket>, response: &DirectFrame) {
        todo!()
    }

    /// Forget a socket, and stop sending it the stream.
    fn remove_connection(&self, ws: &Arc<ChatSocket>) {
        todo!()
    }

    /// Close all connections (for shutdown): each open socket with `1001`
    /// `Server shutting down`, every subscription stopped, the list emptied.
    pub fn close_all(&self) {
        todo!()
    }
}

pub static WEB_SOCKET_GATEWAY_SERVICE: LazyLock<WebSocketGatewayService> =
    LazyLock::new(WebSocketGatewayService::new);
