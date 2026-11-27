//! The chat socket client, protocol version 2 (`docs/websocket-protocol.md`).
//!
//! - Says `hello` first, with the cursor of the last applied event, so a
//!   reconnect gets back every event it missed.
//! - Numbers events: a gap drops the socket, and the reconnect resumes from the
//!   last event applied.
//! - Keeps every message in an outbox until the runtime confirms it, and sends
//!   the outbox again, under the same message ids, after every `welcome`.
//! - Pings every 25 seconds. A socket that does not answer in 10 seconds is dead.
//! - Reconnects with a backoff of 1 s doubling to 30 s. Only a connection that
//!   stays open for 30 seconds resets it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};
use tokio_tungstenite::tungstenite::Message;

use crate::protocol::{
    CLIENT_PING_INTERVAL_MS, CLIENT_PONG_DEADLINE_MS, CLOSE_PROTOCOL_UNSUPPORTED, OutgoingMessage,
    PROTOCOL_VERSION, SendAck, StreamEvent, Welcome,
};

const INITIAL_BACKOFF: Duration = Duration::from_millis(1_000);
const MAX_BACKOFF: Duration = Duration::from_millis(30_000);
const STABLE_AFTER: Duration = Duration::from_millis(30_000);

/// A send's request id is its message id with this prefix, so an `ack` or a
/// `nack` names the message it answers.
const SEND_PREFIX: &str = "send-";

#[derive(Clone, Debug)]
pub struct SendFailure {
    pub message_id: String,
    pub message: String,
}

#[derive(Clone, Debug)]
pub enum WsEvent {
    Welcome(Welcome),
    /// A stream event, in order and without gaps.
    Event(StreamEvent),
    Sent(SendAck),
    SendFailed(SendFailure),
    Disconnected,
    Error(String),
    /// The runtime speaks a newer protocol. The client stops.
    Unsupported,
}

enum Command {
    Send(OutgoingMessage),
    Cancel(String),
    Close,
}

pub struct WsClient {
    commands: mpsc::UnboundedSender<Command>,
    live: Arc<AtomicBool>,
}

impl WsClient {
    /// Connect to `url`, reporting every event to `events`. `client_name` is what this client calls itself in `hello`.
    pub fn connect(
        url: String,
        client_name: &str,
        client_version: &str,
        events: mpsc::UnboundedSender<WsEvent>,
    ) -> WsClient {
        let (tx, rx) = mpsc::unbounded_channel();
        let live = Arc::new(AtomicBool::new(false));
        let task = Connection {
            url,
            client_name: client_name.to_string(),
            client_version: client_version.to_string(),
            events,
            commands: rx,
            live: live.clone(),
            cursor: None,
            outbox: Vec::new(),
            backoff: INITIAL_BACKOFF,
            request_count: 0,
        };
        tokio::spawn(task.run());
        WsClient { commands: tx, live }
    }

    /// Send a message now if the socket is live, and after every `welcome` until it is confirmed.
    pub fn send(&self, message: OutgoingMessage) {
        let _ = self.commands.send(Command::Send(message));
    }

    /// Stop a conversation's work. False when there is no live socket to say it on.
    pub fn cancel(&self, thread_id: &str) -> bool {
        if !self.live.load(Ordering::SeqCst) {
            return false;
        }
        self.commands
            .send(Command::Cancel(thread_id.to_string()))
            .is_ok()
    }

    pub fn close(&self) {
        let _ = self.commands.send(Command::Close);
    }
}

impl Drop for WsClient {
    fn drop(&mut self) {
        self.close();
    }
}

struct Connection {
    url: String,
    client_name: String,
    client_version: String,
    events: mpsc::UnboundedSender<WsEvent>,
    commands: mpsc::UnboundedReceiver<Command>,
    live: Arc<AtomicBool>,
    cursor: Option<(String, u64)>,
    outbox: Vec<OutgoingMessage>,
    backoff: Duration,
    request_count: u64,
}

/// How a socket ended.
enum Ended {
    Closed(u16),
    Stopped,
}

fn far_future() -> Instant {
    Instant::now() + Duration::from_secs(86_400 * 365)
}

impl Connection {
    fn emit(&self, event: WsEvent) {
        let _ = self.events.send(event);
    }

    fn next_id(&mut self, kind: &str) -> String {
        self.request_count += 1;
        format!("{kind}-{}", self.request_count)
    }

    fn keep(&mut self, message: OutgoingMessage) {
        match self.outbox.iter_mut().find(|m| m.id == message.id) {
            Some(slot) => *slot = message,
            None => self.outbox.push(message),
        }
    }

    async fn run(mut self) {
        loop {
            let ended = self.session().await;
            self.live.store(false, Ordering::SeqCst);
            match ended {
                Ended::Stopped => return,
                Ended::Closed(code) if code == CLOSE_PROTOCOL_UNSUPPORTED => {
                    self.emit(WsEvent::Unsupported);
                    return;
                }
                Ended::Closed(..) => self.emit(WsEvent::Disconnected),
            }
            let delay = self.backoff;
            self.backoff = (self.backoff * 2).min(MAX_BACKOFF);
            if !self.wait(delay).await {
                return;
            }
        }
    }

    /// Wait out `delay` while taking commands. False when the client closed.
    async fn wait(&mut self, delay: Duration) -> bool {
        let until = Instant::now() + delay;
        loop {
            tokio::select! {
                _ = sleep_until(until) => return true,
                cmd = self.commands.recv() => match cmd {
                    Some(Command::Send(m)) => self.keep(m),
                    Some(Command::Cancel(_)) => {}
                    Some(Command::Close) | None => return false,
                },
            }
        }
    }

    async fn session(&mut self) -> Ended {
        let connect = tokio_tungstenite::connect_async(self.url.clone());
        tokio::pin!(connect);
        let socket = loop {
            tokio::select! {
                result = &mut connect => break result,
                cmd = self.commands.recv() => match cmd {
                    Some(Command::Send(m)) => self.keep(m),
                    Some(Command::Cancel(_)) => {}
                    Some(Command::Close) | None => return Ended::Stopped,
                },
            }
        };
        let socket = match socket {
            Ok((socket, _)) => socket,
            Err(err) => {
                self.emit(WsEvent::Error(err.to_string()));
                return Ended::Closed(1006);
            }
        };
        let (mut sink, mut stream) = socket.split();
        let stable_at = Instant::now() + STABLE_AFTER;
        let mut stable_pending = true;
        let mut resume = json!({});
        if let Some((stream_id, seq)) = &self.cursor {
            resume = json!({ "resume": { "streamId": stream_id, "seq": seq } });
        }
        let mut payload = json!({
            "protocol": PROTOCOL_VERSION,
            "client": { "name": self.client_name, "version": self.client_version },
        });
        if let (Some(obj), Some(extra)) = (payload.as_object_mut(), resume.as_object()) {
            for (k, v) in extra {
                obj.insert(k.clone(), v.clone());
            }
        }
        let hello_id = self.next_id("hello");
        let hello = json!({ "type": "hello", "id": hello_id, "payload": payload });
        if sink.send(Message::text(hello.to_string())).await.is_err() {
            return Ended::Closed(1006);
        }
        // A runtime that takes `hello` and never answers is as dead as one that stops answering pings.
        let mut deadline: Option<Instant> =
            Some(Instant::now() + Duration::from_millis(CLIENT_PONG_DEADLINE_MS));
        let mut live = false;
        let mut ping_id: Option<String> = None;
        let mut next_ping = far_future();
        let mut retries: Vec<(Instant, String)> = Vec::new();
        loop {
            let next_retry = retries
                .iter()
                .map(|(at, _)| *at)
                .min()
                .unwrap_or_else(far_future);
            let deadline_at = deadline.unwrap_or_else(far_future);
            let mut outgoing: Vec<Value> = Vec::new();
            tokio::select! {
                msg = stream.next() => match msg {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                        if !frame.is_object() || !frame.get("type").is_some_and(Value::is_string) {
                            continue;
                        }
                        let kind = frame["type"].as_str().unwrap_or_default().to_string();
                        if let Some(seq) = frame.get("seq").and_then(Value::as_u64) {
                            let Some(cursor) = self.cursor.as_mut().filter(|_| live) else { continue };
                            if seq != cursor.1 + 1 {
                                return Ended::Closed(1006);
                            }
                            cursor.1 = seq;
                            let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
                            self.emit(WsEvent::Event(StreamEvent { kind, payload }));
                            continue;
                        }
                        let re = frame.get("re").and_then(Value::as_str).map(str::to_string);
                        let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
                        match kind.as_str() {
                            "welcome" => {
                                let Some(welcome) = Welcome::parse(&payload) else { continue };
                                deadline = None;
                                if !welcome.resumed {
                                    self.cursor = Some((welcome.stream_id.clone(), welcome.seq));
                                }
                                live = true;
                                self.live.store(true, Ordering::SeqCst);
                                next_ping = Instant::now() + Duration::from_millis(CLIENT_PING_INTERVAL_MS);
                                self.emit(WsEvent::Welcome(welcome));
                                // Everything unconfirmed goes out now, a message waiting out a rate limit included.
                                retries.clear();
                                for m in &self.outbox {
                                    outgoing.push(send_frame(m));
                                }
                            }
                            "pong" => {
                                if re.is_some() && re == ping_id {
                                    deadline = None;
                                }
                            }
                            "ack" => {
                                let Some(id) = sent_message_id(re.as_deref()) else { continue };
                                self.outbox.retain(|m| m.id != id);
                                self.emit(WsEvent::Sent(SendAck {
                                    message_id: payload.get("messageId").and_then(Value::as_str).unwrap_or(&id).to_string(),
                                    duplicate: payload.get("duplicate").and_then(Value::as_bool).unwrap_or(false),
                                }));
                            }
                            "nack" => {
                                let Some(id) = sent_message_id(re.as_deref()) else { continue };
                                if !self.outbox.iter().any(|m| m.id == id) {
                                    continue;
                                }
                                let code = payload.get("code").and_then(Value::as_str).unwrap_or_default().to_string();
                                if code == "rate_limited" {
                                    let after = payload.get("retryAfterMs").and_then(Value::as_u64).unwrap_or(1_000);
                                    retries.push((Instant::now() + Duration::from_millis(after), id));
                                    continue;
                                }
                                self.outbox.retain(|m| m.id != id);
                                let message = payload.get("message").and_then(Value::as_str).unwrap_or_default().to_string();
                                self.emit(WsEvent::SendFailed(SendFailure { message_id: id, message }));
                            }
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        return Ended::Closed(frame.map(|f| u16::from(f.code)).unwrap_or(1005));
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        self.emit(WsEvent::Error(err.to_string()));
                        return Ended::Closed(1006);
                    }
                    None => return Ended::Closed(1006),
                },
                cmd = self.commands.recv() => match cmd {
                    Some(Command::Send(m)) => {
                        if live {
                            outgoing.push(send_frame(&m));
                        }
                        self.keep(m);
                    }
                    Some(Command::Cancel(thread_id)) => {
                        if live {
                            let id = self.next_id("cancel");
                            outgoing.push(json!({ "type": "cancel", "id": id, "payload": { "threadId": thread_id } }));
                        }
                    }
                    Some(Command::Close) | None => {
                        let _ = sink.close().await;
                        return Ended::Stopped;
                    }
                },
                _ = sleep_until(deadline_at) => return Ended::Closed(1006),
                _ = sleep_until(next_ping), if live => {
                    let id = self.next_id("ping");
                    ping_id = Some(id.clone());
                    outgoing.push(json!({ "type": "ping", "id": id }));
                    deadline = Some(Instant::now() + Duration::from_millis(CLIENT_PONG_DEADLINE_MS));
                    next_ping = Instant::now() + Duration::from_millis(CLIENT_PING_INTERVAL_MS);
                }
                _ = sleep_until(stable_at), if stable_pending => {
                    stable_pending = false;
                    self.backoff = INITIAL_BACKOFF;
                }
                _ = sleep_until(next_retry) => {
                    let now = Instant::now();
                    let due: Vec<String> = retries.iter().filter(|(at, _)| *at <= now).map(|(_, id)| id.clone()).collect();
                    retries.retain(|(at, _)| *at > now);
                    if live {
                        for id in due {
                            if let Some(m) = self.outbox.iter().find(|m| m.id == id) {
                                outgoing.push(send_frame(m));
                            }
                        }
                    }
                }
            }
            for frame in outgoing {
                if sink.send(Message::text(frame.to_string())).await.is_err() {
                    return Ended::Closed(1006);
                }
            }
        }
    }
}

fn send_frame(message: &OutgoingMessage) -> Value {
    json!({ "type": "send", "id": format!("{SEND_PREFIX}{}", message.id), "payload": { "message": message } })
}

fn sent_message_id(re: Option<&str>) -> Option<String> {
    re?.strip_prefix(SEND_PREFIX).map(str::to_string)
}
