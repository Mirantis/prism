//! One remote computer's open link: JSON-RPC 2.0 requests and notifications in both
//! directions, and the binary frames of its screen stream.
//!
//! Every request the runtime sends has a deadline, and a link that closes fails every
//! request still waiting, so no tool call outlives the computer it was sent to.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::link_protocol::{
    LINK_CLOSE, LinkErrorReason, LinkSchema, RPC_ERROR, RpcId, RpcMessage, parse_rpc_message,
};
use crate::log_warn;

/// How long a closing link waits for the client's close frame before it drops the socket.
const CLOSE_TIMEOUT_MS: u64 = 30_000;

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

impl LinkFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkFailure::Refused(reason) => reason.as_str(),
            LinkFailure::Timeout => "timeout",
            LinkFailure::Closed => "closed",
        }
    }
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
        Self::with_data(message, reason, Map::new())
    }

    pub fn with_data(
        message: impl Into<String>,
        reason: LinkFailure,
        data: Map<String, Value>,
    ) -> Self {
        REGISTER_LOG_FIELDS.call_once(|| {
            crate::lib::log_redaction::register_error_fields(log_fields);
        });
        LinkError {
            message: message.into(),
            reason,
            data,
        }
    }
}

/// The error's `name` and `reason`, as a log line shows them.
fn log_fields(err: &(dyn std::error::Error + 'static)) -> Option<Map<String, Value>> {
    let link = err.downcast_ref::<LinkError>()?;
    let mut fields = Map::new();
    fields.insert("name".into(), json!("LinkError"));
    fields.insert("reason".into(), json!(link.reason.as_str()));
    Some(fields)
}

static REGISTER_LOG_FIELDS: std::sync::Once = std::sync::Once::new();

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

/// The close code a read error ends the socket with, and whether it is reported as a
/// socket error. A client that drops its connection is a lost link, not an error.
fn read_failure(err: &axum::Error) -> (u16, bool) {
    let text = err.to_string();
    if text.contains("Space limit exceeded") {
        (1009, true)
    } else if text.contains("UTF-8") {
        (1007, true)
    } else if text.contains("without closing handshake") {
        (1006, false)
    } else if text.contains("protocol error") {
        (1002, true)
    } else {
        (1006, true)
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
    /// By id, which is the order the requests were sent in.
    pending: Mutex<BTreeMap<i64, Pending>>,
    closed: AtomicBool,
    /// Whether the socket is open: set until the socket closes or `close` is called.
    socket_open: AtomicBool,
    /// Frames for the task that writes the socket.
    outgoing: mpsc::UnboundedSender<Message>,
    /// Bytes handed to the writer and not yet sent.
    buffered: Arc<AtomicUsize>,
    listeners: Mutex<Vec<LinkListener>>,
    /// Called when the client answers a ping.
    pong: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    /// Drops the socket: the reading and writing tasks stop, and the link ends as lost.
    stop: CancellationToken,
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
            pending: Mutex::new(BTreeMap::new()),
            closed: AtomicBool::new(false),
            socket_open: AtomicBool::new(true),
            outgoing,
            buffered: Arc::new(AtomicUsize::new(0)),
            listeners: Mutex::new(Vec::new()),
            pong: Mutex::new(None),
            stop: CancellationToken::new(),
            socket: Mutex::new(Some((ws, receiver))),
        })
    }

    /// Start reading and writing the socket.
    pub fn start(&self) {
        let Some((ws, mut receiver)) = self.socket.lock().take() else {
            return;
        };
        let Some(link) = self.me.upgrade() else {
            return;
        };
        let (mut sink, mut stream) = ws.split();

        let stop = self.stop.clone();
        let buffered = Arc::clone(&self.buffered);
        tokio::spawn(async move {
            loop {
                let message = tokio::select! {
                    _ = stop.cancelled() => break,
                    message = receiver.recv() => match message {
                        Some(message) => message,
                        None => break,
                    },
                };
                let size = match &message {
                    Message::Text(text) => text.len(),
                    Message::Binary(data) => data.len(),
                    _ => 0,
                };
                let closing = matches!(message, Message::Close(_));
                let sent = sink.send(message).await;
                buffered.fetch_sub(size, Ordering::SeqCst);
                if sent.is_err() {
                    stop.cancel();
                    break;
                }
                if closing {
                    break;
                }
            }
        });

        let stop = self.stop.clone();
        tokio::spawn(async move {
            // Without a close frame from the client, the link was lost.
            let mut ending: Option<(u16, String)> = None;
            loop {
                let next = tokio::select! {
                    _ = stop.cancelled() => break,
                    next = stream.next() => next,
                };
                match next {
                    None => break,
                    Some(Err(err)) => {
                        let (code, reported) = read_failure(&err);
                        if reported {
                            log_warn!(
                                serde_json::json!({ "err": crate::lib::log_redaction::err_json(&anyhow::Error::new(err)) }),
                                "[Computer:Link] Socket error"
                            );
                        }
                        ending.get_or_insert((code, String::new()));
                        break;
                    }
                    Some(Ok(Message::Text(text))) => {
                        link.receive(Bytes::copy_from_slice(text.as_str().as_bytes()), false)
                    }
                    Some(Ok(Message::Binary(data))) => link.receive(data, true),
                    Some(Ok(Message::Pong(_))) => {
                        let pong = link.pong.lock().clone();
                        if let Some(pong) = pong {
                            pong();
                        }
                    }
                    Some(Ok(Message::Ping(_))) => {}
                    Some(Ok(Message::Close(frame))) => {
                        ending.get_or_insert(match frame {
                            Some(frame) => (frame.code, frame.reason.as_str().to_string()),
                            None => (1005, String::new()),
                        });
                    }
                }
            }
            stop.cancel();
            let (code, reason) = ending.unwrap_or((1006, String::new()));
            link.ended(code, &reason);
        });
    }

    /// Add a listener for every event from here on.
    pub fn on(&self, listener: LinkListener) {
        self.listeners.lock().push(listener);
    }

    /// Run `listener` each time the client answers a ping.
    pub fn on_pong(&self, listener: Arc<dyn Fn() + Send + Sync>) {
        *self.pong.lock() = Some(listener);
    }

    pub fn open(&self) -> bool {
        !self.closed.load(Ordering::SeqCst) && self.socket_open.load(Ordering::SeqCst)
    }

    /// Bytes queued on the socket and not yet sent.
    pub fn buffered_amount(&self) -> usize {
        self.buffered.load(Ordering::SeqCst)
    }

    /// Send a request and wait for its answer, read with `T`'s schema.
    ///
    /// The request goes out when this is called, not when the answer is awaited, so
    /// requests leave in the order they are made. `on_answer` runs as the answer is read,
    /// before any frame that follows it on the link. Fails with `The computer is not
    /// connected.` (closed) when the link is not open, `The computer did not answer in
    /// time.` (timeout) after `timeout_ms`, `The computer sent an answer this runtime
    /// cannot read.` (internal) when the answer fails the schema, the client's own
    /// refusal, and `The computer disconnected.` (closed) when the link closes first.
    /// `params` of `None` sends no `params` key.
    pub fn request<T: LinkSchema>(
        &self,
        method: &str,
        params: Option<Value>,
        timeout_ms: u64,
        on_answer: Option<Box<dyn FnOnce(&T) + Send>>,
    ) -> impl Future<Output = Result<T, LinkError>> + Send + 'static {
        let sent = self.send_request(method, params, timeout_ms, on_answer);
        async move {
            match sent {
                Err(err) => Err(err),
                Ok(answer) => answer.await.unwrap_or_else(|_| {
                    Err(LinkError::new(
                        "The computer disconnected.",
                        LinkFailure::Closed,
                    ))
                }),
            }
        }
    }

    fn send_request<T: LinkSchema>(
        &self,
        method: &str,
        params: Option<Value>,
        timeout_ms: u64,
        on_answer: Option<Box<dyn FnOnce(&T) + Send>>,
    ) -> Result<oneshot::Receiver<Result<T, LinkError>>, LinkError> {
        if !self.open() {
            return Err(LinkError::new(
                "The computer is not connected.",
                LinkFailure::Closed,
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (answered, answer) = oneshot::channel();
        let settle = Box::new(move |result: Result<Value, LinkError>| {
            let read = result.and_then(|value| {
                T::parse(&value).map_err(|_| {
                    LinkError::new(
                        "The computer sent an answer this runtime cannot read.",
                        LinkFailure::Refused(LinkErrorReason::Internal),
                    )
                })
            });
            if let (Ok(value), Some(on_answer)) = (&read, on_answer) {
                on_answer(value);
            }
            let _ = answered.send(read);
        });
        {
            let mut pending = self.pending.lock();
            let me = self.me.clone();
            let timer = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                let Some(link) = me.upgrade() else {
                    return;
                };
                let waiting = link.pending.lock().remove(&id);
                if let Some(waiting) = waiting {
                    (waiting.settle)(Err(LinkError::new(
                        "The computer did not answer in time.",
                        LinkFailure::Timeout,
                    )));
                }
            });
            pending.insert(id, Pending { settle, timer });
        }
        let mut message = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.send(message);
        Ok(answer)
    }

    pub fn notify(&self, method: &str, params: Option<Value>) {
        let mut message = json!({ "jsonrpc": "2.0", "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.send(message);
    }

    pub fn answer(&self, id: &RpcId, result: Value) {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    pub fn fail(&self, id: Option<&RpcId>, code: i64, message: &str) {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }));
    }

    /// Close the socket with `code` and `reason`, when it is still open. A client that
    /// sends no close frame back within `CLOSE_TIMEOUT_MS` loses its socket.
    pub fn close(&self, code: u16, reason: &str) {
        if !self.socket_open.swap(false, Ordering::SeqCst) || self.closed.load(Ordering::SeqCst) {
            return;
        }
        let _ = self.outgoing.send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })));
        let stop = self.stop.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = stop.cancelled() => {}
                _ = tokio::time::sleep(Duration::from_millis(CLOSE_TIMEOUT_MS)) => stop.cancel(),
            }
        });
    }

    /// Ping the client, while the socket is open.
    pub fn ping(&self) {
        if self.socket_open.load(Ordering::SeqCst) {
            let _ = self.outgoing.send(Message::Ping(Bytes::new()));
        }
    }

    /// Drop the socket without a closing handshake; the link ends as lost (1006).
    pub fn terminate(&self) {
        self.socket_open.store(false, Ordering::SeqCst);
        self.stop.cancel();
    }

    /// One JSON message to the client, while the socket is open.
    fn send(&self, message: Value) {
        if !self.socket_open.load(Ordering::SeqCst) {
            return;
        }
        let text = message.to_string();
        self.buffered.fetch_add(text.len(), Ordering::SeqCst);
        if self.outgoing.send(Message::Text(text.into())).is_err() {
            self.buffered.store(0, Ordering::SeqCst);
        }
    }

    /// A frame from the client. Text that is not JSON closes the link (protocol error,
    /// `not JSON`); JSON that is not JSON-RPC 2.0 is failed with `Not a JSON-RPC 2.0
    /// message.` and closes it (`not JSON-RPC 2.0`). An answer to no waiting request is
    /// dropped.
    fn receive(&self, data: Bytes, binary: bool) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        if binary {
            self.emit(LinkEvent::Binary(data));
            return;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&data) else {
            self.close(LINK_CLOSE.protocol_error, "not JSON");
            return;
        };
        let Some(message) = parse_rpc_message(&value) else {
            self.fail(
                None,
                RPC_ERROR.invalid_request,
                "Not a JSON-RPC 2.0 message.",
            );
            self.close(LINK_CLOSE.protocol_error, "not JSON-RPC 2.0");
            return;
        };
        let (id, answer) = match message {
            RpcMessage::Request { id, method, params } => {
                self.emit(LinkEvent::Request(LinkRequest { id, method, params }));
                return;
            }
            RpcMessage::Notification { method, params } => {
                self.emit(LinkEvent::Notification { method, params });
                return;
            }
            RpcMessage::Error { id, error } => {
                let data = match error.data {
                    Some(Value::Object(data)) => data,
                    _ => Map::new(),
                };
                let reason = LinkFailure::Refused(reason_of(&data));
                (id, Err(LinkError::with_data(error.message, reason, data)))
            }
            RpcMessage::Response { id, result } => (Some(id), Ok(result)),
        };
        let Some(RpcId::Number(id)) = id else {
            return;
        };
        let waiting = self.pending.lock().remove(&id);
        let Some(waiting) = waiting else {
            return;
        };
        waiting.timer.abort();
        (waiting.settle)(answer);
    }

    /// The socket closed: every waiting request fails, and the listeners hear `close`.
    fn ended(&self, code: u16, reason: &str) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.socket_open.store(false, Ordering::SeqCst);
        let pending = std::mem::take(&mut *self.pending.lock());
        for waiting in pending.into_values() {
            waiting.timer.abort();
            (waiting.settle)(Err(LinkError::new(
                "The computer disconnected.",
                LinkFailure::Closed,
            )));
        }
        self.emit(LinkEvent::Close {
            code,
            reason: reason.to_string(),
        });
        // Nothing follows a close, and the listeners hold what the link was serving.
        self.listeners.lock().clear();
        *self.pong.lock() = None;
    }

    fn emit(&self, event: LinkEvent) {
        let listeners = self.listeners.lock().clone();
        for listener in listeners {
            listener(&event);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::services::computer::remote::link_protocol::{EmptyResult, StreamStartResult};
    use axum::Router;
    use axum::extract::WebSocketUpgrade;
    use axum::routing::get;
    use tokio_tungstenite::tungstenite::Message as ClientMessage;

    /// A server that hands each socket's link to the test, and a client connected to it.
    pub(crate) async fn linked() -> (
        Arc<ComputerLink>,
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let app = Router::new().route(
            "/link",
            get(move |upgrade: WebSocketUpgrade| {
                let tx = tx.clone();
                async move {
                    upgrade.on_upgrade(move |ws| async move {
                        let _ = tx.send(ComputerLink::new(ws));
                    })
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        let (client, _) = tokio_tungstenite::connect_async(format!("ws://{address}/link"))
            .await
            .unwrap();
        (rx.recv().await.unwrap(), client)
    }

    async fn next_json(
        client: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> Value {
        loop {
            match client.next().await.unwrap().unwrap() {
                ClientMessage::Text(text) => return serde_json::from_str(&text).unwrap(),
                _ => continue,
            }
        }
    }

    /// What a fake client answers a request with: its `result`, or its `error` object.
    pub(crate) type Handler = Arc<dyn Fn(&str, &Value) -> Result<Value, Value> + Send + Sync>;

    /// A computer client: answers requests with its handler (a method it does not handle
    /// is refused with -32601), and records everything it was sent. A clone is the same
    /// client.
    #[derive(Clone)]
    pub(crate) struct FakeClient {
        received: Arc<Mutex<Vec<Value>>>,
        outgoing: mpsc::UnboundedSender<ClientMessage>,
        closed: Arc<Mutex<Option<u16>>>,
    }

    impl FakeClient {
        pub(crate) fn run(
            ws: tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            handler: Handler,
        ) -> FakeClient {
            let (mut sink, mut stream) = ws.split();
            let (outgoing, mut queue) = mpsc::unbounded_channel::<ClientMessage>();
            tokio::spawn(async move {
                while let Some(message) = queue.recv().await {
                    if sink.send(message).await.is_err() {
                        break;
                    }
                }
            });
            let received = Arc::new(Mutex::new(Vec::new()));
            let closed = Arc::new(Mutex::new(None));
            let (seen, ended, answers) =
                (Arc::clone(&received), Arc::clone(&closed), outgoing.clone());
            tokio::spawn(async move {
                while let Some(Ok(message)) = stream.next().await {
                    match message {
                        ClientMessage::Text(text) => {
                            let value: Value = serde_json::from_str(&text).unwrap();
                            seen.lock().push(value.clone());
                            let (Some(method), Some(id)) =
                                (value.get("method").and_then(Value::as_str), value.get("id"))
                            else {
                                continue;
                            };
                            let params = value.get("params").cloned().unwrap_or(json!({}));
                            let answer = match handler(method, &params) {
                                Ok(result) => {
                                    json!({ "jsonrpc": "2.0", "id": id, "result": result })
                                }
                                Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
                            };
                            let _ = answers.send(ClientMessage::text(answer.to_string()));
                        }
                        ClientMessage::Close(frame) => {
                            *ended.lock() =
                                Some(frame.map(|frame| u16::from(frame.code)).unwrap_or(1005));
                        }
                        _ => {}
                    }
                }
                ended.lock().get_or_insert(1006);
            });
            FakeClient {
                received,
                outgoing,
                closed,
            }
        }

        /// A handler that answers each method in `answers` with its value, and refuses the
        /// rest.
        pub(crate) fn answering(answers: Vec<(&'static str, Value)>) -> Handler {
            Arc::new(move |method, _| {
                answers
                    .iter()
                    .find(|(name, _)| *name == method)
                    .map(|(_, value)| value.clone())
                    .ok_or_else(|| json!({ "code": -32601, "message": "no" }))
            })
        }

        pub(crate) fn requests(&self, method: &str) -> Vec<Value> {
            self.received
                .lock()
                .iter()
                .filter(|message| message.get("method").and_then(Value::as_str) == Some(method))
                .cloned()
                .collect()
        }

        /// The answers the client got to its own requests.
        pub(crate) fn answers(&self) -> Vec<Value> {
            self.received
                .lock()
                .iter()
                .filter(|message| message.get("method").is_none())
                .cloned()
                .collect()
        }

        pub(crate) fn send(&self, message: Value) {
            let _ = self.outgoing.send(ClientMessage::text(message.to_string()));
        }

        pub(crate) fn send_binary(&self, data: Vec<u8>) {
            let _ = self.outgoing.send(ClientMessage::binary(data));
        }

        pub(crate) fn close(&self) {
            let _ = self.outgoing.send(ClientMessage::Close(None));
        }

        /// The close code the server sent, or 1006 once the socket ended without one.
        pub(crate) fn closed(&self) -> Option<u16> {
            *self.closed.lock()
        }
    }

    /// Wait up to two seconds for `ready`.
    pub(crate) async fn eventually(ready: impl Fn() -> bool) {
        for _ in 0..200 {
            if ready() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(ready(), "the condition never held");
    }

    #[tokio::test]
    async fn answers_a_request_read_with_its_schema() {
        let (link, mut client) = linked().await;
        link.start();
        let answer = link.request::<StreamStartResult>(
            "stream.start",
            Some(json!({ "fps": 30 })),
            5_000,
            None,
        );
        let sent = next_json(&mut client).await;
        assert_eq!(
            sent.to_string(),
            r#"{"jsonrpc":"2.0","id":1,"method":"stream.start","params":{"fps":30}}"#
        );
        client
            .send(ClientMessage::text(
                r#"{"jsonrpc":"2.0","id":1,"result":{"encoding":"jpeg","width":2,"height":1}}"#,
            ))
            .await
            .unwrap();
        let started = answer.await.unwrap();
        assert_eq!((started.width, started.height), (2, 1));
    }

    #[tokio::test]
    async fn passes_on_a_refusal_with_its_reason() {
        let (link, mut client) = linked().await;
        link.start();
        let answer = link.request::<EmptyResult>("input.text", None, 5_000, None);
        let sent = next_json(&mut client).await;
        assert_eq!(sent.get("params"), None);
        client
            .send(ClientMessage::text(
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"No.","data":{"reason":"held"}}}"#,
            ))
            .await
            .unwrap();
        let err = answer.await.unwrap_err();
        assert_eq!(err.message, "No.");
        assert_eq!(err.reason, LinkFailure::Refused(LinkErrorReason::Held));
    }

    #[tokio::test]
    async fn refuses_an_answer_it_cannot_read() {
        let (link, mut client) = linked().await;
        link.start();
        let answer = link.request::<StreamStartResult>("stream.start", None, 5_000, None);
        next_json(&mut client).await;
        client
            .send(ClientMessage::text(
                r#"{"jsonrpc":"2.0","id":1,"result":{"encoding":"gif"}}"#,
            ))
            .await
            .unwrap();
        let err = answer.await.unwrap_err();
        assert_eq!(
            err.message,
            "The computer sent an answer this runtime cannot read."
        );
    }

    #[tokio::test]
    async fn fails_a_request_nobody_answers_in_time() {
        let (link, _client) = linked().await;
        link.start();
        let err = link
            .request::<EmptyResult>("input.key", None, 50, None)
            .await
            .unwrap_err();
        assert_eq!(err.reason, LinkFailure::Timeout);
        assert_eq!(err.message, "The computer did not answer in time.");
    }

    #[tokio::test]
    async fn fails_the_waiting_requests_when_the_link_closes() {
        let (link, mut client) = linked().await;
        let closes = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&closes);
        link.on(Arc::new(move |event| {
            if let LinkEvent::Close { code, .. } = event {
                seen.lock().push(*code);
            }
        }));
        link.start();
        let answer = link.request::<EmptyResult>("input.key", None, 5_000, None);
        next_json(&mut client).await;
        client.close(None).await.unwrap();
        let err = answer.await.unwrap_err();
        assert_eq!(err.message, "The computer disconnected.");
        assert_eq!(*closes.lock(), [1005]);
        assert!(!link.open());
        let refused = link
            .request::<EmptyResult>("input.key", None, 5_000, None)
            .await
            .unwrap_err();
        assert_eq!(refused.message, "The computer is not connected.");
    }

    #[tokio::test]
    async fn closes_a_link_that_does_not_speak_json_rpc() {
        let (link, mut client) = linked().await;
        link.start();
        client
            .send(ClientMessage::text(r#"{"hello":1}"#))
            .await
            .unwrap();
        let failed = next_json(&mut client).await;
        assert_eq!(
            failed.to_string(),
            r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Not a JSON-RPC 2.0 message."}}"#
        );
        let closed = loop {
            match client.next().await {
                Some(Ok(ClientMessage::Close(frame))) => break frame,
                Some(Ok(_)) => continue,
                other => panic!("{other:?}"),
            }
        };
        assert_eq!(u16::from(closed.unwrap().code), 4400);
    }

    #[tokio::test]
    async fn runs_on_answer_before_the_frames_after_the_answer() {
        let (link, mut client) = linked().await;
        let order = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&order);
        link.on(Arc::new(move |event| {
            if let LinkEvent::Binary(_) = event {
                seen.lock().push("frame");
            }
        }));
        link.start();
        let answered = Arc::clone(&order);
        let answer = link.request::<StreamStartResult>(
            "stream.start",
            None,
            5_000,
            Some(Box::new(move |_| answered.lock().push("answer"))),
        );
        next_json(&mut client).await;
        client
            .send(ClientMessage::text(
                r#"{"jsonrpc":"2.0","id":1,"result":{"encoding":"jpeg","width":2,"height":1}}"#,
            ))
            .await
            .unwrap();
        client
            .send(ClientMessage::binary(vec![1u8, 0, 0xaa]))
            .await
            .unwrap();
        answer.await.unwrap();
        for _ in 0..50 {
            if order.lock().len() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(*order.lock(), ["answer", "frame"]);
    }
}
