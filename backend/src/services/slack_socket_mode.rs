//! A Slack Socket Mode client: the app-level connection that receives events.
//!
//! `start` asks Slack for a socket address with `apps.connections.open`, opens
//! the WebSocket and resolves when Slack's `hello` arrives. Each envelope Slack
//! sends is handed to the client's handler, which acknowledges it by its
//! `envelope_id`. A `disconnect` message from Slack, a dropped socket or a
//! failed health check closes the socket, and the client reconnects after
//! `5 s × <consecutive failures>`. Health: the client pings Slack every
//! 1.7 s and closes a socket that answers no pong for 5 s, and closes one
//! that sends no ping for 30 s after its first.
//!
//! Lifecycle events (`Connected`, `Reconnecting`, `Disconnected`) go to every
//! subscriber, which is what the socket watch reads. `disconnect` ends the
//! session for good: no reconnect follows, and a client whose requests are
//! retired opens no socket again.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures::future::BoxFuture;
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_util::sync::CancellationToken;

use crate::lib::slack_web_client::{
    SOCKET_MODE_RETRY_CONFIG, SlackApiError, SlackWebClient, slack_http_client,
    slack_platform_error_code,
};
use crate::services::slack_socket_retire::{
    RetirableFetch, RetiringClient, StoppableApp, retirable_fetch,
};
use crate::services::slack_socket_watchdog::SocketLifecycleEvent;
use crate::{log_debug, log_error, log_warn};

/// How long to wait for a pong, and the unit of the reconnect delay.
const CLIENT_PING_TIMEOUT_MS: u64 = 5_000;
/// How long a socket may go without a ping from Slack once one arrived.
const SERVER_PING_TIMEOUT_MS: u64 = 30_000;
/// How long a close waits for the peer's close frame.
const CLOSE_HANDSHAKE_TIMEOUT_MS: u64 = 30_000;

/// `apps.connections.open` errors no retry can fix.
const UNRECOVERABLE_START_ERRORS: [&str; 5] = [
    "not_authed",
    "invalid_auth",
    "account_inactive",
    "user_removed_from_team",
    "team_disabled",
];

/// One message Slack sent over the socket, other than `hello` and `disconnect`.
#[derive(Debug, Clone)]
pub struct SocketEnvelope {
    /// The envelope type: `events_api`, `interactive`, `slash_commands`, ….
    pub kind: String,
    pub envelope_id: Option<String>,
    /// The envelope's `payload`.
    pub body: Value,
    pub retry_num: Option<i64>,
    pub retry_reason: Option<String>,
    pub accepts_response_payload: Option<bool>,
}

/// Receives each envelope; the client runs every call on its own task.
pub type EnvelopeHandler =
    Arc<dyn Fn(Arc<SocketModeClient>, SocketEnvelope) -> BoxFuture<'static, ()> + Send + Sync>;

/// What the socket task is asked to do.
enum Control {
    Send(String),
    Disconnect,
}

/// The live socket: its generation, its control channel and whether it is open.
#[derive(Clone)]
struct SocketHandle {
    generation: u64,
    control: mpsc::UnboundedSender<Control>,
    open: Arc<AtomicBool>,
}

#[derive(Default)]
struct State {
    /// Set by `disconnect`; a closed socket then reconnects no more.
    shutting_down: bool,
    consecutive_failures: u32,
    /// A reconnect is waiting out its delay.
    reconnect_pending: bool,
    socket: Option<SocketHandle>,
    next_generation: u64,
    /// Each `start` waiting for `hello`.
    start_waiters: Vec<oneshot::Sender<Result<(), String>>>,
    /// Each `disconnect` waiting for the socket to close.
    disconnect_waiters: Vec<oneshot::Sender<()>>,
    /// The latest `apps.connections.open` answer.
    connection_response: Option<Value>,
}

/// A Socket Mode client for one app token.
pub struct SocketModeClient {
    web: SlackWebClient,
    fetch: RetirableFetch,
    handler: EnvelopeHandler,
    events: broadcast::Sender<SocketLifecycleEvent>,
    state: Mutex<State>,
    /// Cancelled by `disconnect`, so a pending reconnect delay ends with it.
    stopped: CancellationToken,
}

impl SocketModeClient {
    /// A client for `app_token` whose envelopes go to `handler`. `slack_api_url`
    /// overrides the Web API base URL.
    pub fn new(
        app_token: &str,
        slack_api_url: Option<String>,
        handler: EnvelopeHandler,
    ) -> Arc<Self> {
        let fetch = retirable_fetch(slack_http_client());
        let web = SlackWebClient::for_socket_mode(
            app_token,
            SOCKET_MODE_RETRY_CONFIG,
            slack_api_url,
            fetch.clone(),
        );
        let (events, _) = broadcast::channel(32);
        Arc::new(Self {
            web,
            fetch,
            handler,
            events,
            state: Mutex::new(State::default()),
            stopped: CancellationToken::new(),
        })
    }

    /// The lifecycle events from now on.
    pub fn subscribe(&self) -> broadcast::Receiver<SocketLifecycleEvent> {
        self.events.subscribe()
    }

    /// The switch that makes every request of this client go unanswered.
    pub fn retire_requests(&self) {
        self.fetch.retire();
    }

    /// Start a session: resolves at Slack's `hello`, and fails when the session
    /// ends before it or `apps.connections.open` fails for good.
    pub async fn start(self: &Arc<Self>) -> anyhow::Result<()> {
        self.state.lock().shutting_down = false;
        log_debug!("Starting Socket Mode session ...");
        let url = self.retrieve_wss_url().await?;
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.state.lock();
            state.start_waiters.push(tx);
        }
        self.connect(url);
        match rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => Err(anyhow::anyhow!(message)),
            // The waiter was dropped: nobody will ever answer it.
            Err(_) => std::future::pending().await,
        }
    }

    /// End the session: no reconnect follows. Resolves once the socket is closed.
    pub async fn disconnect(self: &Arc<Self>) {
        let (tx, rx) = oneshot::channel();
        let socket = {
            let mut state = self.state.lock();
            state.shutting_down = true;
            state.reconnect_pending = false;
            state.disconnect_waiters.push(tx);
            state.socket.clone()
        };
        self.stopped.cancel();
        log_debug!("Manually disconnecting this Socket Mode client");
        match socket {
            Some(socket) if socket.control.send(Control::Disconnect).is_ok() => {}
            _ => self.emit_disconnected(),
        }
        let _ = rx.await;
    }

    /// Acknowledge an envelope: `{ envelope_id, payload: {} }` on the open socket.
    pub fn ack(&self, envelope_id: Option<&str>) -> anyhow::Result<()> {
        self.send(envelope_id, json!({}))
    }

    /// Send `{ envelope_id, payload }` on the open socket.
    pub fn send(&self, envelope_id: Option<&str>, payload: Value) -> anyhow::Result<()> {
        let socket = self.state.lock().socket.clone();
        let Some(socket) = socket else {
            log_error!("Failed to send a message as the client is not connected");
            anyhow::bail!("Failed to send a message as the client is not connected");
        };
        if !socket.open.load(Ordering::SeqCst) {
            log_error!("Failed to send a message as the client has no active connection");
            anyhow::bail!("Failed to send a message as the client has no active connection");
        }
        let mut message = serde_json::Map::new();
        message.insert(
            "envelope_id".into(),
            envelope_id.map(Value::from).unwrap_or(Value::Null),
        );
        message.insert("payload".into(), payload);
        socket
            .control
            .send(Control::Send(Value::Object(message).to_string()))
            .map_err(|_| anyhow::anyhow!("Failed to send a WebSocket message"))
    }

    fn emit(&self, event: SocketLifecycleEvent) {
        let _ = self.events.send(event);
    }

    /// Every `start` waiting resolves, and the watch hears of it.
    fn emit_connected(&self) {
        let waiters = std::mem::take(&mut self.state.lock().start_waiters);
        for waiter in waiters {
            let _ = waiter.send(Ok(()));
        }
        self.emit(SocketLifecycleEvent::Connected);
    }

    /// Every `start` waiting fails, every `disconnect` waiting resolves, and the
    /// watch hears of it.
    fn emit_disconnected(&self) {
        let (starts, disconnects) = {
            let mut state = self.state.lock();
            (
                std::mem::take(&mut state.start_waiters),
                std::mem::take(&mut state.disconnect_waiters),
            )
        };
        for waiter in starts {
            let _ = waiter.send(Err("The Socket Mode client disconnected".to_string()));
        }
        for waiter in disconnects {
            let _ = waiter.send(());
        }
        self.emit(SocketLifecycleEvent::Disconnected);
    }

    /// A new socket address from `apps.connections.open`. A recoverable failure
    /// waits out the reconnect delay and asks again; a failed auth, a network
    /// failure after the request's own retries, and an HTTP error give up.
    async fn retrieve_wss_url(self: &Arc<Self>) -> anyhow::Result<String> {
        loop {
            log_debug!("Going to retrieve a new WSS URL ...");
            let result = self
                .web
                .api_call("apps.connections.open", json!({}))
                .await
                .and_then(|response| {
                    let url = response.get("url").and_then(Value::as_str).map(str::to_string);
                    match url {
                        Some(url) => Ok((url, response)),
                        None => {
                            let message = "apps.connections.open did not return a URL! (response: [object Object])";
                            log_error!("{}", message);
                            Err(anyhow::anyhow!(message))
                        }
                    }
                });
            match result {
                Ok((url, response)) => {
                    let mut state = self.state.lock();
                    state.consecutive_failures = 0;
                    state.connection_response = Some(response);
                    return Ok(url);
                }
                Err(err) => {
                    log_error!("Failed to retrieve a new WSS URL (error: {})", err);
                    let unrecoverable = slack_platform_error_code(&err)
                        .is_some_and(|code| UNRECOVERABLE_START_ERRORS.contains(&code.as_str()))
                        || matches!(
                            err.downcast_ref::<SlackApiError>(),
                            Some(SlackApiError::Request(_) | SlackApiError::Http { .. })
                        );
                    if unrecoverable {
                        return Err(err);
                    }
                    self.delay_reconnect_attempt().await;
                }
            }
        }
    }

    /// Waits `5 s × <consecutive failures>`, then reports `Reconnecting`. A client
    /// shut down meanwhile never resumes.
    async fn delay_reconnect_attempt(&self) {
        let wait = {
            let mut state = self.state.lock();
            state.consecutive_failures += 1;
            state.reconnect_pending = true;
            CLIENT_PING_TIMEOUT_MS * state.consecutive_failures as u64
        };
        log_debug!(
            "Before trying to reconnect, this client will wait for {} milliseconds",
            wait
        );
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(wait)) => {}
            _ = self.stopped.cancelled() => {}
        }
        let shutting_down = {
            let mut state = self.state.lock();
            state.reconnect_pending = false;
            state.shutting_down
        };
        if shutting_down {
            log_debug!("Client shutting down, will not attempt reconnect.");
            std::future::pending::<()>().await;
        }
        log_debug!("Continuing with reconnect...");
        self.emit(SocketLifecycleEvent::Reconnecting);
    }

    /// Opens a socket to `url` on a task of its own.
    fn connect(self: &Arc<Self>, url: String) {
        let (control, control_rx) = mpsc::unbounded_channel();
        let open = Arc::new(AtomicBool::new(false));
        let generation = {
            let mut state = self.state.lock();
            state.next_generation += 1;
            let generation = state.next_generation;
            state.socket = Some(SocketHandle {
                generation,
                control,
                open: open.clone(),
            });
            generation
        };
        let client = self.clone();
        tokio::spawn(async move {
            client.run_socket(generation, url, control_rx, open).await;
            client.on_socket_closed(generation);
        });
    }

    async fn run_socket(
        self: &Arc<Self>,
        generation: u64,
        url: String,
        mut control: mpsc::UnboundedReceiver<Control>,
        open: Arc<AtomicBool>,
    ) {
        log_debug!("Initiating new WebSocket connection.");
        let ws = match tokio_tungstenite::connect_async(url.as_str()).await {
            Ok((ws, _)) => ws,
            Err(err) => {
                log_error!("WebSocket error occurred: {}", err);
                return;
            }
        };
        log_debug!("WebSocket open event received (connection established)!");
        open.store(true, Ordering::SeqCst);
        let (mut sink, mut stream) = ws.split();

        let ping_every = Duration::from_millis(CLIENT_PING_TIMEOUT_MS / 3);
        let mut pings =
            tokio::time::interval_at(tokio::time::Instant::now() + ping_every, ping_every);
        let mut last_pong: Option<i64> = None;
        let mut ping_attempts = 0u32;
        let mut server_ping_deadline: Option<tokio::time::Instant> = None;
        let mut close_deadline: Option<tokio::time::Instant> = None;

        loop {
            let server_ping = async {
                match server_ping_deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
            let close_wait = async {
                match close_deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
            let mut disconnect = false;
            tokio::select! {
                message = stream.next() => match message {
                    Some(Ok(Message::Text(text))) => self.on_message(text.as_str()),
                    Some(Ok(Message::Binary(_))) => {
                        log_debug!("Unexpected binary message received, ignoring.");
                    }
                    Some(Ok(Message::Ping(_))) => {
                        server_ping_deadline = Some(
                            tokio::time::Instant::now()
                                + Duration::from_millis(SERVER_PING_TIMEOUT_MS),
                        );
                    }
                    Some(Ok(Message::Pong(_))) => last_pong = Some(crate::support::now_ms()),
                    Some(Ok(Message::Close(frame))) => {
                        let (code, reason) = frame
                            .map(|f| (u16::from(f.code), f.reason.to_string()))
                            .unwrap_or((1005, String::new()));
                        log_debug!(
                            "WebSocket close frame received (code: {}, reason: {})",
                            code,
                            reason
                        );
                        log_debug!("Terminating WebSocket (close frame received).");
                        break;
                    }
                    Some(Ok(Message::Frame(_))) => {}
                    Some(Err(err)) => {
                        log_error!("WebSocket error occurred: {}", err);
                        break;
                    }
                    None => break,
                },
                command = control.recv() => match command {
                    Some(Control::Send(text)) => {
                        log_debug!("Sending a WebSocket message: {}", text);
                        if let Err(err) = sink.send(Message::text(text)).await {
                            log_error!("Failed to send a WebSocket message (error: {})", err);
                        }
                    }
                    Some(Control::Disconnect) | None => disconnect = true,
                },
                _ = pings.tick(), if close_deadline.is_none() => {
                    let now = crate::support::now_ms();
                    let ping = format!("Ping from client ({now})");
                    if let Err(err) = sink.send(Message::Ping(ping.into_bytes().into())).await {
                        log_error!("Failed to send ping to Slack (error: {})", err);
                        disconnect = true;
                    } else {
                        if last_pong.is_none() {
                            ping_attempts += 1;
                        } else {
                            ping_attempts = 0;
                        }
                        let invalid = match last_pong {
                            Some(at) => now - at > CLIENT_PING_TIMEOUT_MS as i64,
                            None => ping_attempts > 3,
                        };
                        if invalid {
                            log_warn!(
                                "A pong wasn't received from the server before the timeout of {}ms!",
                                CLIENT_PING_TIMEOUT_MS
                            );
                            disconnect = true;
                        }
                    }
                }
                _ = server_ping => {
                    log_warn!(
                        "A ping wasn't received from the server before the timeout of {}ms!",
                        SERVER_PING_TIMEOUT_MS
                    );
                    server_ping_deadline = None;
                    disconnect = true;
                }
                _ = close_wait => {
                    log_warn!("Peer did not complete the close handshake in time; forcing cleanup.");
                    break;
                }
            }
            if disconnect {
                if close_deadline.is_some() {
                    log_debug!(
                        "Terminating WebSocket (close frame sent but no response, force-terminating)."
                    );
                    break;
                }
                log_debug!("Sending close frame (status=1000).");
                open.store(false, Ordering::SeqCst);
                let frame = CloseFrame {
                    code: CloseCode::Normal,
                    reason: "".into(),
                };
                if sink.send(Message::Close(Some(frame))).await.is_err() {
                    break;
                }
                close_deadline = Some(
                    tokio::time::Instant::now() + Duration::from_millis(CLOSE_HANDSHAKE_TIMEOUT_MS),
                );
            }
        }
        open.store(false, Ordering::SeqCst);
    }

    /// One text message from Slack: `hello` connects, `disconnect` closes the
    /// socket to reconnect, and anything else goes to the handler.
    fn on_message(self: &Arc<Self>, payload: &str) {
        log_debug!("Received a message on the WebSocket: {}", payload);
        let event: Value = match serde_json::from_str(payload) {
            Ok(event) => event,
            Err(err) => {
                log_debug!(
                    "Unable to parse an incoming WebSocket message (will ignore): {}, {}",
                    err,
                    payload
                );
                return;
            }
        };
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "hello" {
            self.emit_connected();
            return;
        }
        if kind == "disconnect" {
            log_debug!(
                "Received \"disconnect\" ({}) message - disconnecting. Will reconnect.",
                event
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("undefined")
            );
            let socket = self.state.lock().socket.clone();
            if let Some(socket) = socket {
                let _ = socket.control.send(Control::Disconnect);
            }
            return;
        }
        let envelope = SocketEnvelope {
            kind: kind.to_string(),
            envelope_id: event
                .get("envelope_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            body: event.get("payload").cloned().unwrap_or(Value::Null),
            retry_num: event.get("retry_attempt").and_then(Value::as_i64),
            retry_reason: event
                .get("retry_reason")
                .and_then(Value::as_str)
                .map(str::to_string),
            accepts_response_payload: event
                .get("accepts_response_payload")
                .and_then(Value::as_bool),
        };
        let handler = self.handler.clone();
        let client = self.clone();
        tokio::spawn(async move { handler(client, envelope).await });
    }

    /// A socket closed. Unless a newer socket is open or a reconnect already
    /// waits, the client reconnects, or, once shut down, reports `Disconnected`.
    fn on_socket_closed(self: &Arc<Self>, generation: u64) {
        let shutting_down = {
            let mut state = self.state.lock();
            match &state.socket {
                Some(socket) if socket.generation == generation => state.socket = None,
                Some(socket) if socket.open.load(Ordering::SeqCst) => return,
                _ => {}
            }
            if state.reconnect_pending {
                return;
            }
            state.shutting_down
        };
        if shutting_down {
            self.emit_disconnected();
            return;
        }
        let client = self.clone();
        tokio::spawn(async move {
            let stopped = client.stopped.clone();
            tokio::select! {
                _ = async {
                    client.delay_reconnect_attempt().await;
                    if let Err(err) = client.start().await {
                        log_error!(
                            "Slack Socket Mode reconnect failed: {}",
                            err
                        );
                    }
                } => {}
                _ = stopped.cancelled() => {}
            }
        });
    }
}

/// The app a Socket Mode client is stopped through.
pub struct SocketModeApp(pub Arc<SocketModeClient>);

#[async_trait]
impl StoppableApp for SocketModeApp {
    async fn stop(&self) -> anyhow::Result<()> {
        self.0.disconnect().await;
        Ok(())
    }
}

impl RetiringClient for SocketModeClient {
    /// `disconnected`: every `start` still waiting is forgotten, so it never
    /// resolves.
    fn remove_all_listeners(&self, event: &str) {
        if event == "disconnected" {
            self.state.lock().start_waiters.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::slack_web_client::testing::fake_slack_api;
    use axum::extract::ws::{Message as WsMessage, WebSocketUpgrade};
    use axum::routing::get;

    /// A Socket Mode server: answers `hello`, then sends one event and records
    /// the acks.
    async fn socket_server(acks: Arc<Mutex<Vec<String>>>) -> String {
        let app = axum::Router::new().route(
            "/socket",
            get(move |upgrade: WebSocketUpgrade| {
                let acks = acks.clone();
                async move {
                    upgrade.on_upgrade(move |mut socket| async move {
                        let _ = socket
                            .send(WsMessage::Text(r#"{"type":"hello"}"#.into()))
                            .await;
                        let event = json!({
                            "type": "events_api",
                            "envelope_id": "env-1",
                            "payload": { "event": { "type": "message", "text": "hi" } },
                        });
                        let _ = socket.send(WsMessage::Text(event.to_string().into())).await;
                        while let Some(Ok(message)) = socket.recv().await {
                            if let WsMessage::Text(text) = message {
                                acks.lock().push(text.to_string());
                            }
                        }
                    })
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("ws://{addr}/socket")
    }

    #[tokio::test]
    async fn connects_hands_over_an_event_and_acknowledges_it() {
        let acks = Arc::new(Mutex::new(Vec::new()));
        let socket_url = socket_server(acks.clone()).await;
        let url = socket_url.clone();
        let api = fake_slack_api(Arc::new(move |_, _| {
            (200, json!({ "ok": true, "url": url }))
        }))
        .await;
        let received = Arc::new(Mutex::new(Vec::<SocketEnvelope>::new()));
        let seen = received.clone();
        let handler: EnvelopeHandler = Arc::new(move |client, envelope| {
            let seen = seen.clone();
            Box::pin(async move {
                client.ack(envelope.envelope_id.as_deref()).unwrap();
                seen.lock().push(envelope);
            })
        });
        let client = SocketModeClient::new("xapp-1", Some(api.url.clone()), handler);
        let mut events = client.subscribe();
        tokio::time::timeout(Duration::from_secs(5), client.start())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            events.recv().await.unwrap(),
            SocketLifecycleEvent::Connected
        );

        let open = &api.calls("apps.connections.open")[0];
        assert_eq!(open.headers.get("authorization").unwrap(), "Bearer xapp-1");

        for _ in 0..100 {
            if !acks.lock().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(received.lock()[0].kind, "events_api");
        assert_eq!(received.lock()[0].body["event"]["text"], "hi");
        assert_eq!(
            acks.lock().first().map(String::as_str),
            Some(r#"{"envelope_id":"env-1","payload":{}}"#)
        );

        tokio::time::timeout(Duration::from_secs(5), client.disconnect())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn gives_up_on_a_token_slack_refuses() {
        let api = fake_slack_api(Arc::new(|_, _| {
            (200, json!({ "ok": false, "error": "invalid_auth" }))
        }))
        .await;
        let handler: EnvelopeHandler = Arc::new(|_, _| Box::pin(async {}));
        let client = SocketModeClient::new("xapp-bad", Some(api.url.clone()), handler);
        let err = client.start().await.unwrap_err();
        assert_eq!(err.to_string(), "An API error occurred: invalid_auth");
    }
}
