//! Holds the terminal UI's copy of the chat socket contract (`protocol.rs`) to the
//! session the runtime recorded in `backend/src/protocol/fixtures/v2-session.json`:
//! two clients on one conversation, a duplicate resend, a reconnect that resumes,
//! a refused send, a ping and a cancel. A local socket server plays the phone's
//! side of the recording to the real `WsClient`, across its reconnect, and the
//! frames this client sends are compared with the recorded ones.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

use crate::protocol::{OutgoingMessage, Role, TurnEvent, TurnOutcome, TurnState, coerce_message};
use crate::transcript::{ChatEntry, upsert_message};
use crate::ws_client::{WsClient, WsEvent};

const RECORDING: &str = include_str!("../../backend/src/protocol/fixtures/v2-session.json");
const WAIT: Duration = Duration::from_secs(20);

fn recording() -> Value {
    serde_json::from_str(RECORDING).expect("the recording is JSON")
}

/// A value's structure, with every leaf replaced by its type.
fn shape_of(value: &Value) -> Value {
    match value {
        Value::Array(_) => json!("array"),
        Value::Null => json!("null"),
        Value::Bool(_) => json!("boolean"),
        Value::Number(_) => json!("number"),
        Value::String(_) => json!("string"),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), shape_of(v)))
                .collect::<Map<_, _>>(),
        ),
    }
}

/// The recorded frame a client sent, by its type.
fn recorded_sent(recording: &Value, kind: &str) -> Value {
    recording["log"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["direction"] == "sent" && e["frame"]["type"] == kind)
        .map(|e| e["frame"].clone())
        .unwrap_or_else(|| panic!("the recording has no sent {kind} frame"))
}

async fn next_frame(ws: &mut WebSocketStream<tokio::net::TcpStream>) -> Value {
    loop {
        match timeout(WAIT, ws.next()).await.expect("a frame in time") {
            Some(Ok(Message::Text(text))) => return serde_json::from_str(text.as_str()).unwrap(),
            Some(Ok(_)) => continue,
            other => panic!("the client closed the socket: {other:?}"),
        }
    }
}

async fn listen() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/api/ws", listener.local_addr().unwrap());
    (listener, url)
}

async fn accept(listener: &TcpListener) -> WebSocketStream<tokio::net::TcpStream> {
    let (tcp, _) = timeout(WAIT, listener.accept()).await.unwrap().unwrap();
    tokio_tungstenite::accept_async(tcp).await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn replays_the_phones_frames_across_its_reconnect_into_the_transcript() {
    let recording = recording();
    let thread_id = recording["threadId"].as_str().unwrap().to_string();
    let phone: Vec<Value> = recording["log"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["client"] == "phone")
        .cloned()
        .collect();
    let sockets = phone.iter().filter(|e| e["direction"] == "closed").count();
    assert_eq!(sockets, 2, "the phone reconnects once in the recording");

    let (listener, url) = listen().await;
    let server = tokio::spawn(async move {
        let mut hellos = Vec::new();
        let mut log = phone.into_iter().peekable();
        while log.peek().is_some() {
            let mut ws = accept(&listener).await;
            for entry in log.by_ref() {
                match entry["direction"].as_str().unwrap() {
                    "sent" => hellos.push((next_frame(&mut ws).await, entry["frame"].clone())),
                    "received" => ws
                        .send(Message::text(entry["frame"].to_string()))
                        .await
                        .unwrap(),
                    // Closed with no status, as the recording's 1005 says.
                    _ => {
                        let _ = ws.close(None).await;
                        break;
                    }
                }
            }
        }
        hellos
    });

    let (tx, mut events) = mpsc::unbounded_channel();
    let client = WsClient::connect(url, "second-client", "fixture", tx);
    let mut entries: Vec<ChatEntry> = Vec::new();
    let mut turns: Vec<TurnEvent> = Vec::new();
    let mut viewers: Vec<Option<String>> = Vec::new();
    let mut disconnects = 0;
    while disconnects < sockets {
        match timeout(WAIT, events.recv())
            .await
            .expect("an event in time")
        {
            Some(WsEvent::Welcome(w)) => viewers.push(w.you.id),
            Some(WsEvent::Event(e)) if e.kind == "message" => {
                upsert_message(&mut entries, coerce_message(&e.payload).expect("a message"))
            }
            Some(WsEvent::Event(e)) if e.kind == "turn" => {
                turns.push(TurnEvent::parse(&e.payload).expect("a turn"))
            }
            Some(WsEvent::Disconnected) => disconnects += 1,
            Some(WsEvent::Unsupported) | None => panic!("the client stopped"),
            Some(_) => {}
        }
    }
    client.close();

    let hellos = timeout(WAIT, server).await.unwrap().unwrap();
    assert_eq!(hellos.len(), 2);
    for (sent, recorded) in &hellos {
        assert_eq!(shape_of(sent), shape_of(recorded));
        assert_eq!(sent["payload"]["protocol"], 2);
        // The reconnect resumes from the last event the first socket applied.
        assert_eq!(
            sent["payload"].get("resume"),
            recorded["payload"].get("resume")
        );
    }

    assert_eq!(
        entries.iter().map(|e| e.message.role).collect::<Vec<_>>(),
        [Role::User, Role::Agent, Role::User, Role::Agent]
    );
    assert_eq!(
        entries
            .iter()
            .map(|e| e.message.content.as_str())
            .collect::<Vec<_>>(),
        [
            "Reply with exactly: pong",
            "pong",
            "Reply with exactly: ping",
            "ping"
        ]
    );
    // Another person wrote the USER messages, on the web.
    assert_eq!(
        entries[0].message.sender_id.as_deref(),
        Some("ada@example.com")
    );
    assert_eq!(
        viewers,
        [
            Some("grace@example.com".to_string()),
            Some("grace@example.com".to_string())
        ]
    );
    assert_eq!(
        turns.last(),
        Some(&TurnEvent {
            thread_id,
            state: TurnState::Idle,
            outcome: Some(TurnOutcome::Completed),
            error: None,
        })
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_send_and_cancel_frames_of_the_recorded_shapes() {
    let recording = recording();
    let thread_id = recording["threadId"].as_str().unwrap().to_string();
    let welcome = recording["log"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["client"] == "web" && e["frame"]["type"] == "welcome")
        .map(|e| e["frame"].clone())
        .unwrap();

    let (listener, url) = listen().await;
    let (tx, mut events) = mpsc::unbounded_channel();
    let client = WsClient::connect(url, "prism-cli", "fixture", tx);
    let mut ws = accept(&listener).await;
    assert_eq!(next_frame(&mut ws).await["type"], "hello");
    ws.send(Message::text(welcome.to_string())).await.unwrap();
    loop {
        if let Some(WsEvent::Welcome(_)) = timeout(WAIT, events.recv()).await.unwrap() {
            break;
        }
    }

    client.send(OutgoingMessage {
        id: uuid::Uuid::new_v4().to_string(),
        thread_id: thread_id.clone(),
        content: "Reply with exactly: pong".into(),
        attachment_ids: Vec::new(),
    });
    let send = next_frame(&mut ws).await;
    assert_eq!(
        shape_of(&send),
        shape_of(&recorded_sent(&recording, "send"))
    );
    assert_eq!(send["payload"]["message"]["threadId"], thread_id.as_str());

    assert!(client.cancel(&thread_id));
    let cancel = next_frame(&mut ws).await;
    assert_eq!(
        shape_of(&cancel),
        shape_of(&recorded_sent(&recording, "cancel"))
    );
    assert_eq!(cancel["payload"]["threadId"], thread_id.as_str());
    client.close();
}
