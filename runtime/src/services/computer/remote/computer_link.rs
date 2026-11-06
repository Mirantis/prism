//! One remote computer's open link: JSON-RPC 2.0 requests and notifications in both
//! directions, and the binary frames of its screen stream.
//!
//! Every request the runtime sends has a deadline, and a link that closes fails every
//! request still waiting, so no tool call outlives the computer it was sent to.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize};
use std::sync::{Arc, Weak};

use axum::extract::ws::{Message, WebSocket};
use bytes::Bytes;
use parking_lot::Mutex;
use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::link_protocol::{LinkErrorReason, LinkSchema, RpcId};

/// What failed a request: the computer's own refusal, or the link.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LinkFailure {
    /// The client refused, with `error.data.reason`.
    Refused(LinkErrorReason),
    /// The computer did not answer by the deadline.
    Timeout,
    /// The link was closed, or was never open.
    Closed,
}

/// Why a request to the computer failed: its own refusal, or the link.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct LinkError {
    pub message: String,
    pub reason: LinkFailure,
    /// The refusal's `error.data`; empty for the link's own failures.
    pub data: Map<String, Value>,
}

impl LinkError {
    pub fn new(message: impl Into<String>, reason: LinkFailure) -> Self {
        LinkError {
            message: message.into(),
            reason,
            data: Map::new(),
        }
    }
}

/// A request from the client.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkRequest {
    pub id: RpcId,
    pub method: String,
    pub params: Option<Value>,
}

/// What the link reports to its listeners, in the order the frames arrived.
#[derive(Debug, Clone, PartialEq)]
pub enum LinkEvent {
    Request(LinkRequest),
    Notification {
        method: String,
        params: Option<Value>,
    },
    Binary(Bytes),
    Close {
        code: u16,
        reason: String,
    },
}

/// A listener on a link. Listeners run in the order they were added, inside the task that
/// reads the link, so each sees a frame before the next frame is read.
pub type LinkListener = Arc<dyn Fn(&LinkEvent) + Send + Sync>;

/// The reason in a refusal's `data`, where it is one the protocol names; else `Internal`.
fn reason_of(data: &Map<String, Value>) -> LinkErrorReason {
    match data.get("reason").and_then(Value::as_str) {
        Some("permission_denied") => LinkErrorReason::PermissionDenied,
        Some("unsupported") => LinkErrorReason::Unsupported,
        Some("held") => LinkErrorReason::Held,
        Some("busy") => LinkErrorReason::Busy,
        Some("invalid_params") => LinkErrorReason::InvalidParams,
        _ => LinkErrorReason::Internal,
    }
}

/// A request waiting for its answer.
struct Pending {
    /// Reads the answer with the request's schema, runs its `on_answer`, and settles it.
    settle: Box<dyn FnOnce(Result<Value, LinkError>) + Send>,
    timer: JoinHandle<()>,
}

/// Reports `request` (a `LinkRequest`), `notification` (method, params), `binary` (the
/// frame's bytes) and `close` (code, reason) to its listeners.
pub struct ComputerLink {
    me: Weak<ComputerLink>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, Pending>>,
    closed: AtomicBool,
    /// Whether the socket is open: set until the socket closes or `close` is called.
    socket_open: AtomicBool,
    /// Frames for the task that writes the socket.
    outgoing: mpsc::UnboundedSender<Message>,
    /// Bytes handed to the writer and not yet sent.
    buffered: Arc<AtomicUsize>,
    listeners: Mutex<Vec<LinkListener>>,
    /// The socket, until `start` hands it to the reading and writing tasks.
    socket: Mutex<Option<(WebSocket, mpsc::UnboundedReceiver<Message>)>>,
}

impl ComputerLink {
    /// A link over `ws`. It reads nothing until `start`, so the listeners added before
    /// that see every frame.
    pub fn new(ws: WebSocket) -> Arc<Self> {
        let (outgoing, receiver) = mpsc::unbounded_channel();
        Arc::new_cyclic(|me| ComputerLink {
            me: me.clone(),
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            socket_open: AtomicBool::new(true),
            outgoing,
            buffered: Arc::new(AtomicUsize::new(0)),
            listeners: Mutex::new(Vec::new()),
            socket: Mutex::new(Some((ws, receiver))),
        })
    }

    /// Start reading and writing the socket.
    pub fn start(&self) {
        todo!()
    }

    /// Add a listener for every event from here on.
    pub fn on(&self, listener: LinkListener) {
        self.listeners.lock().push(listener);
    }

    pub fn open(&self) -> bool {
        todo!()
    }

    /// Bytes queued on the socket and not yet sent.
    pub fn buffered_amount(&self) -> usize {
        todo!()
    }

    /// Send a request and wait for its answer, read with `T`'s schema.
    ///
    /// `on_answer` runs as the answer is read, before any frame that follows it on the
    /// link. Fails with `The computer is not connected.` (closed) when the link is not
    /// open, `The computer did not answer in time.` (timeout) after `timeout_ms`, `The
    /// computer sent an answer this runtime cannot read.` (internal) when the answer fails
    /// the schema, the client's own refusal, and `The computer disconnected.` (closed) when
    /// the link closes first. `params` of `None` sends no `params` key.
    pub async fn request<T: LinkSchema>(
        &self,
        method: &str,
        params: Option<Value>,
        timeout_ms: u64,
        on_answer: Option<Box<dyn FnOnce(&T) + Send>>,
    ) -> Result<T, LinkError> {
        todo!()
    }

    pub fn notify(&self, method: &str, params: Option<Value>) {
        todo!()
    }

    pub fn answer(&self, id: &RpcId, result: Value) {
        todo!()
    }

    pub fn fail(&self, id: Option<&RpcId>, code: i64, message: &str) {
        todo!()
    }

    /// Close the socket with `code` and `reason`, when it is still open.
    pub fn close(&self, code: u16, reason: &str) {
        todo!()
    }

    /// One JSON message to the client, while the socket is open.
    fn send(&self, message: Value) {
        todo!()
    }

    /// A frame from the client. Text that is not JSON closes the link (protocol error,
    /// `not JSON`); JSON that is not JSON-RPC 2.0 is failed with `Not a JSON-RPC 2.0
    /// message.` and closes it (`not JSON-RPC 2.0`). An answer to no waiting request is
    /// dropped.
    fn receive(&self, data: Bytes, binary: bool) {
        todo!()
    }

    /// The socket closed: every waiting request fails, and the listeners hear `close`.
    fn ended(&self, code: u16, reason: &str) {
        todo!()
    }

    fn emit(&self, event: LinkEvent) {
        let listeners = self.listeners.lock().clone();
        for listener in listeners {
            listener(&event);
        }
    }
}
