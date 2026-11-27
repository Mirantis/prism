//! Just enough of the Prism runtime for a terminal UI: the REST reads a session
//! makes at start-up and the chat socket, protocol version 2. A benchmark pushes
//! stream events to every connected socket, so the TUI's own work is all that is
//! measured.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::broadcast;

pub const THREAD_ID: &str = "11111111-2222-4333-8444-555555555555";

pub struct FakeRuntime {
    pub port: u16,
    events: broadcast::Sender<String>,
    seq: Arc<AtomicU64>,
}

#[derive(Clone)]
struct AppState {
    single: bool,
    history: Arc<Vec<Value>>,
    events: broadcast::Sender<String>,
    seq: Arc<AtomicU64>,
}

/// A stored message as the runtime sends it.
pub fn message(id: &str, role: &str, content: &str, created_at: &str) -> Value {
    json!({
        "id": id,
        "threadId": THREAD_ID,
        "role": role,
        "content": content,
        "triggeredBy": "USER_INPUT",
        "toolCalls": null,
        "blocks": null,
        "createdAt": created_at,
    })
}

impl FakeRuntime {
    /// Serve on a free port. `single` puts the agent in single-thread mode, so a TUI
    /// opens the one conversation with `history` in it.
    pub async fn start(single: bool, history: Vec<Value>) -> anyhow::Result<FakeRuntime> {
        let (events, _) = broadcast::channel(4096);
        let seq = Arc::new(AtomicU64::new(0));
        let state = AppState {
            single,
            history: Arc::new(history),
            events: events.clone(),
            seq: seq.clone(),
        };
        let app = Router::new()
            .route("/health", get(|| async { "ok" }))
            .route("/agents/me", get(me))
            .route("/threads", get(list_threads).post(create_thread))
            .route("/messages", get(messages))
            .route("/agents/update/status", get(update_status))
            .route(
                "/agents/llm-provider",
                get(|| async { Json(json!({ "provider": "bench", "missingSettings": [] })) }),
            )
            .route("/api/ws", get(socket))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(FakeRuntime { port, events, seq })
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Send one stream event to every connected socket.
    pub fn push(&self, kind: &str, payload: Value) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self
            .events
            .send(json!({ "type": kind, "seq": seq, "payload": payload }).to_string());
    }

    pub fn turn(&self, state: &str) {
        self.push("turn", json!({ "threadId": THREAD_ID, "state": state }));
    }
}

async fn me(State(s): State<AppState>) -> impl IntoResponse {
    Json(
        json!({ "agentId": "bench", "userId": "bench", "name": "Prism", "threadMode": if s.single { "single" } else { "multi" } }),
    )
}

async fn list_threads() -> impl IntoResponse {
    Json(
        json!([{ "id": THREAD_ID, "title": "bench", "updatedAt": "2026-11-27T12:00:00.000Z", "workspaceRoot": null, "branch": null }]),
    )
}

async fn create_thread() -> impl IntoResponse {
    Json(json!({ "threadId": THREAD_ID }))
}

async fn messages(State(s): State<AppState>) -> impl IntoResponse {
    Json(Value::Array(s.history.as_ref().clone()))
}

async fn update_status() -> impl IntoResponse {
    Json(json!({
        "enabled": false, "reason": "dev_build", "currentVersion": "0.0.0", "latestVersion": null,
        "updateAvailable": false, "checkedAt": null, "applying": false, "lastAttempt": null,
    }))
}

async fn socket(ws: WebSocketUpgrade, State(s): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| serve_socket(socket, s))
}

async fn serve_socket(socket: WebSocket, s: AppState) {
    let (mut sink, mut stream) = socket.split();
    let mut events = s.events.subscribe();
    loop {
        tokio::select! {
            frame = stream.next() => {
                let Some(Ok(Message::Text(text))) = frame else { return };
                let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                let id = frame.get("id").cloned().unwrap_or(Value::Null);
                let reply = match frame.get("type").and_then(Value::as_str) {
                    Some("hello") => json!({ "type": "welcome", "re": id, "payload": {
                        "protocol": 2, "streamId": "bench", "seq": s.seq.load(Ordering::SeqCst), "resumed": false,
                        "you": { "id": null, "name": null },
                        "threadMode": if s.single { "single" } else { "multi" },
                        "snapshot": { "turns": [] },
                    }}),
                    Some("ping") => json!({ "type": "pong", "re": id }),
                    Some("send") => {
                        let message_id = frame["payload"]["message"]["id"].clone();
                        json!({ "type": "ack", "re": id, "payload": { "messageId": message_id, "seq": 0, "queued": false, "duplicate": false } })
                    }
                    _ => continue,
                };
                if sink.send(Message::text(reply.to_string())).await.is_err() {
                    return;
                }
            }
            event = events.recv() => {
                let Ok(event) = event else { continue };
                if sink.send(Message::text(event)).await.is_err() {
                    return;
                }
            }
        }
    }
}
