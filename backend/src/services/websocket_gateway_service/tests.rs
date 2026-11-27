//! Chat protocol v2, against real sockets: a real handshake against the real
//! gateway, its real stream and the real inbound message service, on a fresh
//! database.

use std::sync::Arc;
use std::time::Duration;

use diesel::prelude::*;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::*;
use crate::db::models::{
    MessageRole, MessageTrigger, NewAgentWorkspace, NewConversationMessage, NewConversationThread,
};
use crate::db::schema::{agent_workspaces, conversation_messages, conversation_threads};
use crate::db::sql_types::DbDateTime;
use crate::lib::tool_lifecycle::{ToolLifecycleEvent, ToolLifecycleEventType};
use crate::protocol::chat_protocol::SequencedEvent;
use crate::protocol::chat_protocol::{TurnEventPayload, TurnState};
use crate::services::agent_workspace_service::AGENT_WORKSPACE_SERVICE;
use crate::services::context_usage_service::{ContextUsageEvent, ContextUsageSnapshot};
use crate::services::conversation_service::ThreadCreated;
use crate::services::message_delivery_service::MESSAGE_DELIVERY_SERVICE;
use crate::services::websocket_adapter_service::WebSocketAdapterService;
use crate::types::{InvokeRequest, InvokeStep, ToolCallRecord};

const THREAD: &str = "d046783b-f46e-43b5-b4bb-247e6b1915bf";
const MESSAGE: &str = "8d7e6f5a-4b3c-4d2e-9f1a-0b1c2d3e4f5a";

/// A runtime HTTP server with the gateway on `/api/ws`; answers its URL.
async fn serve() -> String {
    WEB_SOCKET_GATEWAY_SERVICE.initialize();
    if MESSAGE_DELIVERY_SERVICE.get_adapter("websocket").is_none() {
        MESSAGE_DELIVERY_SERVICE.register(Arc::new(WebSocketAdapterService::new()));
    }
    let app = axum::Router::new()
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(axum::middleware::from_fn(
            crate::services::websocket_upgrades::upgrade_middleware,
        ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("ws://127.0.0.1:{port}/api/ws")
}

/// The agent row and the conversation the clients write in.
async fn seed() {
    crate::db::run(|conn| {
        let mut agent = NewAgentWorkspace::new(CONFIG.owner_user_id(), "", "", "", "", "");
        agent.id = CONFIG.agent_id().unwrap();
        diesel::insert_into(agent_workspaces::table)
            .values(&agent)
            .execute(conn)?;
        let mut thread = NewConversationThread::new(agent.id.clone(), CONFIG.owner_user_id());
        thread.id = THREAD.into();
        diesel::insert_into(conversation_threads::table)
            .values(&thread)
            .execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
}

/// Start each test on a stream of its own, as a restart would.
fn fresh_stream() {
    WEB_SOCKET_GATEWAY_SERVICE.close_all();
    EVENT_STREAM_SERVICE.reset_for_tests();
    INBOUND_MESSAGE_SERVICE.reset_for_tests();
}

/// A client that keeps every frame it was sent, and can wait for the next one.
struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    frames: Vec<Value>,
    closed: Option<u16>,
}

impl Client {
    async fn open(url: &str, headers: &[(&str, &str)]) -> Client {
        Self::try_open(url, headers)
            .await
            .expect("the handshake succeeds")
    }

    async fn try_open(
        url: &str,
        headers: &[(&str, &str)],
    ) -> Result<Client, tokio_tungstenite::tungstenite::Error> {
        let mut request = url.into_client_request().unwrap();
        for (name, value) in headers {
            request.headers_mut().insert(
                http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                http::HeaderValue::from_str(value).unwrap(),
            );
        }
        let (ws, _) = tokio_tungstenite::connect_async(request).await?;
        Ok(Client {
            ws,
            frames: Vec::new(),
            closed: None,
        })
    }

    async fn send(&mut self, frame: Value) {
        self.ws
            .send(WsMessage::Text(frame.to_string().into()))
            .await
            .unwrap();
    }

    async fn hello(&mut self, resume: Option<(String, i64)>) {
        let mut payload = json!({ "protocol": PROTOCOL_VERSION, "client": { "name": "test" } });
        if let Some((stream_id, seq)) = resume {
            payload["resume"] = json!({ "streamId": stream_id, "seq": seq });
        }
        self.send(json!({ "type": "hello", "id": "hello-1", "payload": payload }))
            .await;
    }

    /// Read one more frame, or the close. False when nothing came in time.
    async fn read(&mut self) -> bool {
        if self.closed.is_some() {
            return false;
        }
        match tokio::time::timeout(Duration::from_secs(5), self.ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                self.frames.push(serde_json::from_str(&text).unwrap());
                true
            }
            Ok(Some(Ok(WsMessage::Close(frame)))) => {
                self.closed = Some(frame.map_or(1005, |f| u16::from(f.code)));
                true
            }
            Ok(Some(Ok(_))) => true,
            Ok(Some(Err(_))) | Ok(None) => {
                self.closed.get_or_insert(1006);
                true
            }
            Err(_) => false,
        }
    }

    /// Wait until some frame matches, and answer it.
    async fn next(&mut self, matches: impl Fn(&Value) -> bool) -> Value {
        loop {
            if let Some(found) = self.frames.iter().find(|f| matches(f)) {
                return found.clone();
            }
            assert!(
                self.closed.is_none(),
                "closed {:?} before a match",
                self.closed
            );
            assert!(self.read().await, "no matching frame arrived");
        }
    }

    /// The next frame after the ones already read.
    async fn next_frame(&mut self) -> Value {
        let seen = self.frames.len();
        while self.frames.len() == seen {
            assert!(self.closed.is_none(), "closed {:?}", self.closed);
            assert!(self.read().await, "no frame arrived");
        }
        self.frames[seen].clone()
    }

    async fn welcome(&mut self) -> Value {
        self.next(|f| f["type"] == "welcome").await
    }

    async fn closed_with(&mut self) -> u16 {
        while self.closed.is_none() {
            assert!(self.read().await, "the socket stayed open");
        }
        self.closed.unwrap()
    }

    async fn close(mut self) {
        let _ = self.ws.close(None).await;
        while self.closed.is_none() && self.read().await {}
    }
}

fn turn_event() -> StreamEvent {
    StreamEvent::Turn(TurnEventPayload {
        thread_id: THREAD.into(),
        state: TurnState::Running,
        outcome: None,
        error: None,
        step: None,
    })
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn answers_hello_with_the_stream_position_and_who_is_connected() {
    let _db = crate::db::testing::test_db();
    fresh_stream();
    let url = serve().await;
    let mut client = Client::open(&url, &[("x-forwarded-user", "<ada@example.com>")]).await;
    client.hello(None).await;
    let welcome = client.welcome().await;
    assert_eq!(welcome["payload"]["protocol"], PROTOCOL_VERSION);
    assert_eq!(
        welcome["payload"]["streamId"],
        EVENT_STREAM_SERVICE.stream_id()
    );
    assert_eq!(welcome["payload"]["seq"], EVENT_STREAM_SERVICE.seq());
    assert_eq!(welcome["payload"]["resumed"], false);
    // The ingress gives an email, which is the id and the name. Brackets and colons
    // are stripped: it is shown, never parsed.
    assert_eq!(
        welcome["payload"]["you"],
        json!({ "id": "ada@example.com", "name": "ada@example.com" })
    );
    assert_eq!(welcome["payload"]["threadMode"], "multi");
    assert_eq!(welcome["payload"]["snapshot"]["turns"], json!([]));
    client.close().await;
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn names_the_connection_from_the_ingress_headers() {
    let _db = crate::db::testing::test_db();
    fresh_stream();
    let url = serve().await;
    let emoji = "😀".repeat(200);
    let long_name = format!("Ada\u{7} {emoji}");
    let encoded: String = long_name.bytes().map(|b| format!("%{b:02X}")).collect();
    let cases: Vec<(Vec<(&str, &str)>, Value)> = vec![
        (
            vec![
                ("x-forwarded-user", "ada@example.com"),
                ("x-forwarded-user-id", "user-ada-1"),
                (
                    "x-forwarded-user-display-name",
                    "Ada%20Lovelace%20%C3%85str%C3%B6m",
                ),
            ],
            json!({ "id": "user-ada-1", "name": "Ada Lovelace Åström" }),
        ),
        (
            vec![
                ("x-forwarded-user", "ada@example.com"),
                ("x-forwarded-user-id", "user-ada-1"),
                ("x-forwarded-user-display-name", "%E0%A4%A"),
            ],
            json!({ "id": "user-ada-1", "name": "ada@example.com" }),
        ),
        (
            vec![
                ("x-forwarded-user", "ada@example.com"),
                ("x-forwarded-user-display-name", "%3C%3E%20"),
            ],
            json!({ "id": "ada@example.com", "name": "ada@example.com" }),
        ),
        (
            vec![("x-forwarded-user-id", "user-ada-1")],
            json!({ "id": "user-ada-1", "name": "user-ada-1" }),
        ),
        (
            vec![
                ("x-forwarded-user", "ada@example.com"),
                ("x-forwarded-user-display-name", encoded.as_str()),
            ],
            json!({ "id": "ada@example.com", "name": format!("Ada {}", "😀".repeat(124)) }),
        ),
        (vec![], json!({ "id": null, "name": null })),
    ];
    for (headers, you) in cases {
        let mut client = Client::open(&url, &headers).await;
        client.hello(None).await;
        assert_eq!(client.welcome().await["payload"]["you"], you);
        client.close().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn tells_a_client_of_another_protocol_to_update_and_closes_it() {
    let _db = crate::db::testing::test_db();
    fresh_stream();
    let url = serve().await;
    let mut old = Client::open(&url, &[]).await;
    old.send(json!({ "type": "chat", "payload": { "mode": "followup", "content": "hi", "threadId": THREAD } }))
        .await;
    let nack = old.next(|f| f["type"] == "nack").await;
    assert_eq!(nack["re"], Value::Null);
    assert_eq!(nack["payload"]["code"], "protocol_unsupported");
    assert_eq!(old.closed_with().await, CLOSE_CODES.protocol_unsupported);

    let mut v1 = Client::open(&url, &[]).await;
    v1.send(json!({ "type": "hello", "id": "h", "payload": { "protocol": 1, "client": { "name": "old" } } }))
        .await;
    assert_eq!(v1.closed_with().await, CLOSE_CODES.protocol_unsupported);
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn answers_a_hello_sent_twice_once_and_sends_the_stream_once() {
    let _db = crate::db::testing::test_db();
    fresh_stream();
    let url = serve().await;
    let mut client = Client::open(&url, &[]).await;
    // Audio before hello is ignored.
    client
        .ws
        .send(WsMessage::Binary(vec![0u8; 960].into()))
        .await
        .unwrap();
    client.hello(None).await;
    client
        .send(json!({ "type": "hello", "id": "hello-2", "payload": { "protocol": PROTOCOL_VERSION, "client": { "name": "test" } } }))
        .await;
    client.welcome().await;
    let second = client.next(|f| f["re"] == "hello-2").await;
    assert_eq!(second["type"], "nack");
    assert_eq!(second["payload"]["code"], "invalid");

    let entry = EVENT_STREAM_SERVICE.publish(turn_event());
    client.next(|f| f["seq"] == entry.seq).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    while client.read_ready().await {}
    assert_eq!(
        client
            .frames
            .iter()
            .filter(|f| f["type"] == "welcome")
            .count(),
        1
    );
    assert_eq!(
        client
            .frames
            .iter()
            .filter(|f| f["seq"] == entry.seq)
            .count(),
        1
    );
    assert!(client.closed.is_none());
    client.close().await;
}

impl Client {
    /// Read a frame that is already waiting, without waiting for one.
    async fn read_ready(&mut self) -> bool {
        match tokio::time::timeout(Duration::from_millis(20), self.ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                self.frames.push(serde_json::from_str(&text).unwrap());
                true
            }
            _ => false,
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn sends_every_event_to_every_client_and_resumes_a_returning_one() {
    let _db = crate::db::testing::test_db();
    fresh_stream();
    let url = serve().await;
    let mut a = Client::open(&url, &[]).await;
    let mut b = Client::open(&url, &[]).await;
    a.hello(None).await;
    b.hello(None).await;
    let welcome = a.welcome().await;
    b.welcome().await;

    let entry = EVENT_STREAM_SERVICE.publish(turn_event());
    for client in [&mut a, &mut b] {
        assert_eq!(
            client.next(|f| f["seq"] == entry.seq).await,
            json!({ "type": "turn", "payload": { "threadId": THREAD, "state": "running" }, "seq": entry.seq })
        );
    }

    let stream_id = welcome["payload"]["streamId"].as_str().unwrap().to_string();
    let cursor = entry.seq;
    a.close().await;
    let missed = [
        EVENT_STREAM_SERVICE.publish(turn_event()),
        EVENT_STREAM_SERVICE.publish(turn_event()),
    ];
    let mut back = Client::open(&url, &[]).await;
    back.hello(Some((stream_id, cursor))).await;
    let welcome = back.welcome().await;
    assert_eq!(welcome["payload"]["resumed"], true);
    assert_eq!(welcome["payload"]["seq"], missed[1].seq);
    let live = EVENT_STREAM_SERVICE.publish(StreamEvent::Thread(ThreadEventPayload {
        thread_id: THREAD.into(),
        title: Some("Hello".into()),
        created_at: None,
    }));
    back.next(|f| f["seq"] == live.seq).await;
    let order: Vec<Value> = back
        .frames
        .iter()
        .map(|f| f.get("seq").cloned().unwrap_or_else(|| f["type"].clone()))
        .collect();
    assert_eq!(
        order,
        vec![
            json!("welcome"),
            json!(missed[0].seq),
            json!(missed[1].seq),
            json!(live.seq)
        ]
    );

    // A cursor from another process is told to reload, and nothing is replayed.
    let mut other = Client::open(&url, &[]).await;
    other.hello(Some(("a-previous-process".into(), 1))).await;
    assert_eq!(other.welcome().await["payload"]["resumed"], false);
    tokio::time::sleep(Duration::from_millis(50)).await;
    while other.read_ready().await {}
    assert_eq!(other.frames.len(), 1);
    for client in [back, other, b] {
        client.close().await;
    }
}

fn send_frame(id: &str, message: Value) -> Value {
    let mut payload =
        json!({ "id": MESSAGE, "threadId": THREAD, "content": "hello", "attachmentIds": [] });
    for (key, value) in message.as_object().unwrap() {
        payload[key] = value.clone();
    }
    json!({ "type": "send", "id": id, "payload": { "message": payload } })
}

async fn ready(url: &str) -> Client {
    let mut client = Client::open(url, &[]).await;
    client.hello(None).await;
    client.welcome().await;
    client
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn refuses_requests_the_contract_or_the_service_refuses() {
    let _db = crate::db::testing::test_db();
    fresh_stream();
    let url = serve().await;
    let mut client = ready(&url).await;

    client
        .send(send_frame("req-2", json!({ "id": "local-123" })))
        .await;
    let bad_id = client.next(|f| f["re"] == "req-2").await;
    assert_eq!(
        bad_id["payload"],
        json!({ "code": "invalid", "message": "must be a uuid v4" })
    );

    client
        .send(send_frame("req-3", json!({ "content": "   " })))
        .await;
    let empty = client.next(|f| f["re"] == "req-3").await;
    assert_eq!(empty["payload"]["code"], "invalid");

    // The conversation does not exist.
    client.send(send_frame("req-4", json!({}))).await;
    let unknown = client.next(|f| f["re"] == "req-4").await;
    assert_eq!(unknown["payload"]["code"], "unknown_thread");

    client
        .send(json!({ "type": "cancel", "id": "c-2", "payload": { "threadId": THREAD } }))
        .await;
    let cancel = client.next(|f| f["re"] == "c-2").await;
    assert_eq!(cancel["payload"]["code"], "unknown_thread");

    client.send(json!({ "type": "ping", "id": "p-1" })).await;
    assert_eq!(
        client.next(|f| f["re"] == "p-1").await,
        json!({ "type": "pong", "re": "p-1" })
    );

    client
        .ws
        .send(WsMessage::Text("not json".into()))
        .await
        .unwrap();
    let not_json = client
        .next(|f| f["type"] == "nack" && f["payload"]["message"] == "A frame must be JSON.")
        .await;
    assert_eq!(not_json["re"], Value::Null);
    client.close().await;
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn tells_a_client_over_the_rate_when_to_try_again_and_keeps_it_connected() {
    let _db = crate::db::testing::test_db();
    fresh_stream();
    let url = serve().await;
    let mut client = ready(&url).await;
    for i in 0..30 {
        client.send(send_frame(&format!("r-{i}"), json!({}))).await;
    }
    let limited = client
        .next(|f| f["type"] == "nack" && f["payload"]["code"] == "rate_limited")
        .await;
    assert!(limited["payload"]["retryAfterMs"].as_i64().unwrap() > 0);
    client
        .send(json!({ "type": "ping", "id": "still-there" }))
        .await;
    assert_eq!(
        client.next(|f| f["re"] == "still-there").await["type"],
        "pong"
    );
    client.close().await;
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn replaces_the_oldest_connection_rather_than_refusing_a_new_one() {
    let _db = crate::db::testing::test_db();
    fresh_stream();
    let url = serve().await;
    let mut oldest = Client::open(&url, &[]).await;
    let mut rest = Vec::new();
    for _ in 1..MAX_CONNECTIONS {
        rest.push(Client::open(&url, &[]).await);
    }
    let mut newest = Client::open(&url, &[]).await;
    assert_eq!(oldest.closed_with().await, CLOSE_CODES.replaced);
    newest.hello(None).await;
    assert_eq!(newest.welcome().await["type"], "welcome");
    newest.close().await;
    for client in rest {
        client.close().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn applies_the_origin_rules_to_the_handshake() {
    let _db = crate::db::testing::test_db();
    fresh_stream();
    let url = serve().await;
    Client::open(&url, &[]).await.close().await;
    Client::open(&url, &[("origin", "http://localhost:5173")])
        .await
        .close()
        .await;
    for origin in ["https://evil.example", "null"] {
        let refused = Client::try_open(&url, &[("origin", origin)]).await;
        match refused {
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                assert_eq!(response.status(), 403, "{origin}");
            }
            Err(other) => panic!("{origin}: {other}"),
            Ok(_) => panic!("{origin} opened"),
        }
    }
}

// ============================================================================
// The recorded session
// ============================================================================

const SESSION: &str = include_str!("../../protocol/fixtures/v2-session.json");

/// Whether `stream` holds an event `matches` accepts.
fn published(matches: impl Fn(&SequencedEvent) -> bool) -> bool {
    EVENT_STREAM_SERVICE
        .replay_after(&EVENT_STREAM_SERVICE.stream_id(), 0)
        .unwrap_or_default()
        .iter()
        .any(|entry| matches(&entry.event))
}

async fn wait_until(what: &str, done: impl Fn() -> bool) {
    for _ in 0..500 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

/// The model of the recorded session: it answers "Reply with exactly: X" with X,
/// and the turn reports its context and touches the computer, as the recording did.
fn recorded_model() -> crate::services::conversation_engine_service::testing::Invoke {
    Arc::new(|request: InvokeRequest| {
        futures::stream::once(async move {
            let reply = request.prompt.rsplit(": ").next().unwrap_or_default().to_string();
            let thread_id = request.thread_id.clone().unwrap_or_default();
            let first = reply == "pong";
            if first {
                wait_until("the generated title", || {
                    published(|e| {
                        matches!(&e.event, StreamEvent::Thread(t) if t.title.as_deref() == Some("pong"))
                    })
                })
                .await;
            }
            let computers_before = EVENT_STREAM_SERVICE
                .replay_after(&EVENT_STREAM_SERVICE.stream_id(), 0)
                .unwrap_or_default()
                .iter()
                .filter(|e| e.event.event.type_name() == "computer")
                .count();
            CONTEXT_USAGE_SERVICE.events.emit_usage(&ContextUsageEvent {
                user_id: request.user_id.clone(),
                snapshot: ContextUsageSnapshot {
                    thread_id,
                    model_id: "us.anthropic.claude-opus-4-7".into(),
                    used_tokens: if first { 12921 } else { 12943 },
                    window_tokens: 1_000_000,
                    used_percent: 1,
                },
            });
            COMPUTER_SERVICE.emit_change();
            wait_until("the computer state", || {
                EVENT_STREAM_SERVICE
                    .replay_after(&EVENT_STREAM_SERVICE.stream_id(), 0)
                    .unwrap_or_default()
                    .iter()
                    .filter(|e| e.event.event.type_name() == "computer")
                    .count()
                    > computers_before
            })
            .await;
            Ok(InvokeStep {
                text: reply,
                ..InvokeStep::default()
            })
        })
        .boxed()
    })
}

/// `ours` with what the recording cannot fix made equal to `recorded`: the stream id,
/// the ids and times the runtime minted, fields added since the recording, and the
/// computer state's fields beyond the recorded ones.
fn normalized(mut ours: Value, recorded: &Value) -> Value {
    match recorded["type"].as_str() {
        Some("welcome") => {
            ours["payload"]["streamId"] = recorded["payload"]["streamId"].clone();
            let computer = &recorded["payload"]["snapshot"]["computer"];
            ours["payload"]["snapshot"]["computer"] =
                only_keys_of(&ours["payload"]["snapshot"]["computer"], computer);
            if recorded["payload"]["snapshot"]
                .get("questionCards")
                .is_none()
            {
                ours["payload"]["snapshot"]
                    .as_object_mut()
                    .unwrap()
                    .shift_remove("questionCards");
            }
        }
        Some("computer") => ours["payload"] = only_keys_of(&ours["payload"], &recorded["payload"]),
        Some("message") => {
            if recorded["payload"]["role"] == "AGENT" {
                ours["payload"]["id"] = recorded["payload"]["id"].clone();
            }
            ours["payload"]["createdAt"] = recorded["payload"]["createdAt"].clone();
            if recorded["payload"].get("agentMessageKind").is_none() {
                ours["payload"]
                    .as_object_mut()
                    .unwrap()
                    .shift_remove("agentMessageKind");
            }
        }
        _ => {}
    }
    ours
}

fn only_keys_of(ours: &Value, recorded: &Value) -> Value {
    let Some(keys) = recorded.as_object() else {
        return ours.clone();
    };
    Value::Object(
        keys.keys()
            .filter_map(|key| ours.get(key).map(|value| (key.clone(), value.clone())))
            .collect(),
    )
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn plays_the_recorded_session_frame_for_frame() {
    let _db = crate::db::testing::test_db();
    fresh_stream();
    seed().await;
    let url = serve().await;
    *crate::services::thread_title_service::testing::GENERATE.write() =
        Some(Arc::new(|text: &str| {
            text.rsplit(": ").next().map(str::to_string)
        }));
    *crate::services::conversation_engine_service::testing::INVOKE.write() = Some(recorded_model());
    // The conversation was started before the recording, which is the stream's first event.
    CONVERSATION_SERVICE.events.emit_thread(&ThreadCreated {
        user_id: CONFIG.owner_user_id(),
        thread_id: THREAD.into(),
        title: None,
        created_at: chrono::Utc::now(),
    });

    let session: Value = serde_json::from_str(SESSION).unwrap();
    let senders = [
        ("web", "ada@example.com"),
        ("phone", "grace@example.com"),
        ("old-client", ""),
    ];
    let mut clients: std::collections::HashMap<String, Client> = std::collections::HashMap::new();
    for entry in session["log"].as_array().unwrap() {
        let name = entry["client"].as_str().unwrap();
        match entry["direction"].as_str().unwrap() {
            "sent" => {
                if !clients.contains_key(name) {
                    let header = senders.iter().find(|(n, _)| *n == name).unwrap().1;
                    let headers: Vec<(&str, &str)> = if header.is_empty() {
                        vec![]
                    } else {
                        vec![("x-forwarded-user", header)]
                    };
                    clients.insert(name.to_string(), Client::open(&url, &headers).await);
                }
                // A resume names this process's stream, which the recording cannot.
                let mut frame = entry["frame"].clone();
                if let Some(resume) = frame["payload"].get_mut("resume") {
                    resume["streamId"] = json!(EVENT_STREAM_SERVICE.stream_id());
                }
                clients.get_mut(name).unwrap().send(frame).await;
            }
            "received" => {
                let client = clients.get_mut(name).unwrap();
                let ours = client.next_frame().await;
                let recorded = &entry["frame"];
                assert_eq!(normalized(ours, recorded), *recorded, "{name}");
            }
            "closed" => {
                let mut client = clients.remove(name).unwrap();
                let expected = entry["code"].as_u64().unwrap() as u16;
                if expected == 1005 {
                    // The client closes; the server answers with its code.
                    client.close().await;
                } else {
                    assert_eq!(client.closed_with().await, expected, "{name}");
                }
            }
            other => panic!("unexpected direction {other}"),
        }
    }

    *crate::services::conversation_engine_service::testing::INVOKE.write() = None;
    *crate::services::thread_title_service::testing::GENERATE.write() = None;
}

// ============================================================================
// The step a running turn is on
// ============================================================================

fn started(request: &InvokeRequest, tool: &str, step: usize) {
    (request.on_tool_event.as_ref().unwrap())(ToolLifecycleEvent {
        kind: ToolLifecycleEventType::Started,
        tool_name: tool.into(),
        step,
    });
}

/// A model whose first step calls `web_search` and `fetch_page` at once and says
/// "Looking it up.", and whose second step calls `read_file`, once `release` lets it.
fn stepping_model(
    release: Arc<tokio::sync::Notify>,
) -> crate::services::conversation_engine_service::testing::Invoke {
    Arc::new(move |request: InvokeRequest| {
        let request = Arc::new(request);
        let (first, second) = (request.clone(), request);
        let release = release.clone();
        let tool_call: ToolCallRecord = serde_json::from_value(json!({
            "tool": "web_search",
            "input": "{}",
            "output": "",
            "success": true,
            "timestamp": "2026-01-01"
        }))
        .unwrap();
        futures::stream::once(async move {
            started(&first, "web_search", 1);
            started(&first, "fetch_page", 1);
            Ok(InvokeStep {
                text: "Looking it up.".into(),
                tool_calls: vec![tool_call],
                ..InvokeStep::default()
            })
        })
        .chain(futures::stream::once(async move {
            release.notified().await;
            started(&second, "read_file", 2);
            Ok(InvokeStep {
                text: "Done.".into(),
                ..InvokeStep::default()
            })
        }))
        .boxed()
    })
}

/// Runs one turn on the stepping model and checks the steps every client is told,
/// in the `turn` events and in the `welcome` of a client that connects mid-turn.
/// Answers the texts of the turn's `message` events.
async fn run_a_stepping_turn(verbose: bool) -> Vec<Value> {
    fresh_stream();
    seed().await;
    AGENT_WORKSPACE_SERVICE
        .update_verbose(&json!(verbose))
        .await
        .unwrap();
    let url = serve().await;
    let release = Arc::new(tokio::sync::Notify::new());
    *crate::services::thread_title_service::testing::GENERATE.write() =
        Some(Arc::new(|_: &str| None));
    *crate::services::conversation_engine_service::testing::INVOKE.write() =
        Some(stepping_model(release.clone()));

    let mut client = ready(&url).await;
    client.send(send_frame("s1", json!({}))).await;
    client
        .next(|f| f["type"] == "turn" && f["payload"]["step"]["index"] == 1)
        .await;
    let mut late = Client::open(&url, &[]).await;
    late.hello(None).await;
    let welcome = late.welcome().await;
    assert_eq!(
        welcome["payload"]["snapshot"]["turns"],
        json!([{ "threadId": THREAD, "state": "running", "step": { "index": 1, "tool": "web_search" } }])
    );
    release.notify_one();
    client
        .next(|f| f["type"] == "turn" && f["payload"]["state"] == "idle")
        .await;

    let turns: Vec<Value> = client
        .frames
        .iter()
        .filter(|f| f["type"] == "turn")
        .map(|f| f["payload"].clone())
        .collect();
    assert_eq!(
        turns,
        [
            json!({ "threadId": THREAD, "state": "running" }),
            json!({ "threadId": THREAD, "state": "running", "step": { "index": 1, "tool": "web_search" } }),
            json!({ "threadId": THREAD, "state": "running", "step": { "index": 2, "tool": "read_file" } }),
            json!({ "threadId": THREAD, "state": "idle", "outcome": "completed" }),
        ]
    );
    let texts = client
        .frames
        .iter()
        .filter(|f| f["type"] == "message" && f["payload"]["role"] == "AGENT")
        .map(|f| f["payload"]["content"].clone())
        .collect();
    late.close().await;
    client.close().await;
    *crate::services::conversation_engine_service::testing::INVOKE.write() = None;
    *crate::services::thread_title_service::testing::GENERATE.write() = None;
    texts
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn a_concise_turn_reports_its_step_and_keeps_the_steps_text_hidden() {
    let _db = crate::db::testing::test_db();
    let texts = run_a_stepping_turn(false).await;
    assert_eq!(texts, [json!("Done.")]);
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn a_verbose_turn_reports_its_step_and_shows_the_steps_text() {
    let _db = crate::db::testing::test_db();
    let texts = run_a_stepping_turn(true).await;
    assert_eq!(texts, [json!("Looking it up."), json!("Done.")]);
}

// ============================================================================
// Waiting question cards
// ============================================================================

const OTHER_THREAD: &str = "5b1e8c2d-7a4f-4e3b-9c6d-1f2e3a4b5c6d";

/// A message in `thread_id` whose question card has `id` and `status`, stored at `second`.
async fn seed_card(thread_id: &str, id: &str, status: &str, second: u32) {
    let mut row = NewConversationMessage::new(
        thread_id,
        MessageRole::Agent,
        "Budget?",
        MessageTrigger::UserInput,
    );
    row.created_at = DbDateTime(
        chrono::DateTime::parse_from_rfc3339(&format!("2026-01-01T00:00:{second:02}Z"))
            .unwrap()
            .into(),
    );
    let mut card = json!({
        "type": "question_card",
        "id": id,
        "status": status,
        "questions": [{ "text": "Budget?", "options": [{ "label": "Low" }, { "label": "High" }], "allowOther": false, "multiSelect": false }],
        "otherMaxLength": 500
    });
    if status == "answered" {
        card["answers"] = json!([{ "options": [0] }]);
        card["answeredBy"] = Value::Null;
    }
    row.blocks = Some(json!([card]));
    crate::db::run(move |conn| {
        diesel::insert_into(conversation_messages::table)
            .values(&row)
            .execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn lists_the_waiting_question_cards_of_every_conversation_in_the_welcome() {
    let _db = crate::db::testing::test_db();
    fresh_stream();
    seed().await;
    crate::db::run(|conn| {
        let mut thread =
            NewConversationThread::new(CONFIG.agent_id().unwrap(), CONFIG.owner_user_id());
        thread.id = OTHER_THREAD.into();
        diesel::insert_into(conversation_threads::table)
            .values(&thread)
            .execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
    let (answered, first, second) = (
        "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        "1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e",
        "2c3d4e5f-6a7b-4c8d-ae9f-1a2b3c4d5e6f",
    );
    seed_card(THREAD, answered, "answered", 1).await;
    seed_card(OTHER_THREAD, first, "waiting", 2).await;
    seed_card(THREAD, second, "waiting", 3).await;
    let url = serve().await;

    let mut client = Client::open(&url, &[]).await;
    client.hello(None).await;
    let welcome = client.welcome().await;

    assert_eq!(
        welcome["payload"]["snapshot"]["questionCards"],
        json!([
            { "id": first, "threadId": OTHER_THREAD },
            { "id": second, "threadId": THREAD },
        ])
    );
    client.close().await;
}
