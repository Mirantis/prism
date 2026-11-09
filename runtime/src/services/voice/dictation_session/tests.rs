//! Protocol-level tests against a real local WebSocket server standing in for the Realtime
//! endpoint, so the frames a dictation sends are checked as they go over the wire.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};

use super::*;
use crate::services::meeting::realtime_session::tests::MockServer;

/// `ms` of pcm16 at 24 kHz filled with `byte`, the size a client frame has.
fn pcm(ms: u64, byte: u8) -> Vec<u8> {
    vec![byte; ((ms as f64 / 1000.0) * 24_000.0).round() as usize * 2]
}

async fn settle(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

#[derive(Default)]
struct Recorder {
    calls: Mutex<Vec<(String, Option<String>)>>,
}

impl DictationSignal for Recorder {
    fn ready(&self) {
        self.calls.lock().push(("ready".into(), None));
    }
    fn delta(&self, text: &str) {
        self.calls.lock().push(("delta".into(), Some(text.into())));
    }
    fn result(&self, text: &str) {
        self.calls.lock().push(("result".into(), Some(text.into())));
    }
    fn error(&self, message: &str) {
        self.calls
            .lock()
            .push(("error".into(), Some(message.into())));
    }
}

impl Recorder {
    fn calls(&self) -> Vec<(String, Option<String>)> {
        self.calls.lock().clone()
    }
}

fn call(kind: &str, text: Option<&str>) -> (String, Option<String>) {
    (kind.to_string(), text.map(str::to_string))
}

struct Harness {
    server: MockServer,
    session: Arc<DictationSession>,
    signal: Arc<Recorder>,
    ended: Arc<AtomicUsize>,
    started: tokio::task::JoinHandle<bool>,
}

impl Harness {
    fn sent(&self) -> Vec<Value> {
        self.server.sent()
    }

    fn types(&self) -> Vec<String> {
        self.sent()
            .iter()
            .map(|f| f["type"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    /// Accept the configuration the way the Realtime API does.
    fn accept(&self) {
        self.server
            .emit(json!({ "type": "session.updated", "session": {} }));
    }
}

#[derive(Default)]
struct Limits {
    max_audio_ms: Option<u64>,
    connect_timeout_ms: Option<u64>,
    result_timeout_ms: Option<u64>,
}

async fn harness(limits: Limits) -> Harness {
    let server = MockServer::start().await;
    let signal = Arc::new(Recorder::default());
    let ended = Arc::new(AtomicUsize::new(0));
    let counter = ended.clone();
    let session = DictationSession::new(DictationSessionOptions {
        user_id: "user-1".into(),
        signal: signal.clone(),
        on_end: Some(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })),
        endpoint_override: Some(server.endpoint()),
        max_audio_ms: limits.max_audio_ms,
        connect_timeout_ms: limits.connect_timeout_ms,
        result_timeout_ms: limits.result_timeout_ms,
    });
    let starter = session.clone();
    let started = tokio::spawn(async move { starter.start().await });
    settle(40).await;
    Harness {
        server,
        session,
        signal,
        ended,
        started,
    }
}

#[tokio::test]
async fn configures_a_transcription_only_session_with_no_turn_detection() {
    let h = harness(Limits::default()).await;
    let update = &h.sent()[0];
    assert_eq!(update["type"], "session.update");
    assert_eq!(update["session"]["output_modalities"], json!(["text"]));
    assert_eq!(
        update["session"]["audio"]["input"],
        json!({
            "format": { "type": "audio/pcm", "rate": 24_000 },
            "turn_detection": null,
            "transcription": { "model": CONFIG.openai_transcription_model },
        })
    );
    h.session.cancel(DictationCancelReason::Cancelled);
}

#[tokio::test]
async fn reports_ready_once_the_upstream_accepts_the_configuration() {
    let h = harness(Limits::default()).await;
    assert!(h.signal.calls().is_empty());
    h.accept();
    assert!(h.started.await.unwrap());
    assert_eq!(h.signal.calls(), vec![call("ready", None)]);
    h.session.cancel(DictationCancelReason::Cancelled);
}

#[tokio::test]
async fn keeps_audio_sent_while_connecting_and_forwards_it_in_order_once_ready() {
    let h = harness(Limits::default()).await;
    let first = pcm(20, 1);
    let second = pcm(20, 2);
    h.session.push_audio(&first);
    h.session.push_audio(&second);
    settle(20).await;
    // Nothing but the configuration has gone out before the upstream is ready.
    assert_eq!(h.types(), vec!["session.update"]);

    h.accept();
    h.started.await.unwrap();
    settle(20).await;

    let encode = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let appended: Vec<Value> = h
        .sent()
        .into_iter()
        .filter(|f| f["type"] == "input_audio_buffer.append")
        .map(|f| f["audio"].clone())
        .collect();
    assert_eq!(
        appended,
        vec![json!(encode(&first)), json!(encode(&second))]
    );
    h.session.cancel(DictationCancelReason::Cancelled);
}

#[tokio::test]
async fn commits_on_stop_and_answers_the_transcript_deltas_first() {
    let h = harness(Limits::default()).await;
    h.accept();
    h.started.await.unwrap();
    h.session.push_audio(&pcm(500, 0));
    h.session.commit();
    settle(20).await;
    assert_eq!(
        h.sent().last().unwrap(),
        &json!({ "type": "input_audio_buffer.commit" })
    );

    h.server.emit(json!({ "type": "conversation.item.input_audio_transcription.delta", "item_id": "i1", "delta": "Hello, " }));
    h.server.emit(json!({ "type": "conversation.item.input_audio_transcription.delta", "item_id": "i1", "delta": "world." }));
    h.server.emit(json!({ "type": "conversation.item.input_audio_transcription.completed", "item_id": "i1", "transcript": " Hello, world. " }));
    settle(20).await;

    assert_eq!(
        h.signal.calls(),
        vec![
            call("ready", None),
            call("delta", Some("Hello, ")),
            call("delta", Some("world.")),
            call("result", Some("Hello, world.")),
        ]
    );
    assert_eq!(h.ended.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn honours_a_stop_that_arrives_before_the_upstream_is_ready() {
    let h = harness(Limits::default()).await;
    h.session.push_audio(&pcm(300, 0));
    h.session.commit();

    h.accept();
    h.started.await.unwrap();
    settle(20).await;

    // The client has already let go, so it is not told to start recording.
    assert!(!h.signal.calls().iter().any(|(kind, _)| kind == "ready"));
    assert_eq!(
        h.types(),
        vec![
            "session.update",
            "input_audio_buffer.append",
            "input_audio_buffer.commit"
        ]
    );
    h.session.cancel(DictationCancelReason::Cancelled);
}

#[tokio::test]
async fn answers_an_empty_transcript_without_committing_a_buffer_too_short_to_transcribe() {
    let h = harness(Limits::default()).await;
    h.accept();
    h.started.await.unwrap();
    h.session.push_audio(&pcm(40, 0));
    h.session.commit();
    settle(20).await;

    assert!(!h.types().iter().any(|t| t == "input_audio_buffer.commit"));
    assert_eq!(h.signal.calls().last(), Some(&call("result", Some(""))));
}

#[tokio::test]
async fn drops_the_recording_on_cancel_and_sends_nothing_back() {
    let h = harness(Limits::default()).await;
    h.accept();
    h.started.await.unwrap();
    h.session.push_audio(&pcm(500, 0));
    h.session.cancel(DictationCancelReason::Cancelled);
    settle(20).await;

    assert!(!h.types().iter().any(|t| t == "input_audio_buffer.commit"));
    assert_eq!(h.signal.calls(), vec![call("ready", None)]);
    assert_eq!(h.ended.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn commits_by_itself_when_a_recording_outlasts_the_cap_without_audio() {
    let h = harness(Limits {
        max_audio_ms: Some(150),
        ..Default::default()
    })
    .await;
    h.accept();
    h.started.await.unwrap();
    h.session.push_audio(&pcm(120, 0));
    settle(250).await;
    assert_eq!(
        h.sent().last().unwrap(),
        &json!({ "type": "input_audio_buffer.commit" })
    );
    h.session.cancel(DictationCancelReason::Cancelled);
}

#[tokio::test]
async fn commits_by_itself_at_the_recording_cap() {
    let h = harness(Limits {
        max_audio_ms: Some(200),
        ..Default::default()
    })
    .await;
    h.accept();
    h.started.await.unwrap();
    h.session.push_audio(&pcm(100, 0));
    h.session.push_audio(&pcm(100, 0));
    h.session.push_audio(&pcm(100, 0));
    settle(20).await;
    let types = h.types();
    assert_eq!(
        types
            .iter()
            .filter(|t| *t == "input_audio_buffer.append")
            .count(),
        2
    );
    assert_eq!(types.last().unwrap(), "input_audio_buffer.commit");
    h.session.cancel(DictationCancelReason::Cancelled);
}

#[tokio::test]
async fn reports_a_transcription_failure_as_an_error() {
    let h = harness(Limits::default()).await;
    h.accept();
    h.started.await.unwrap();
    h.session.push_audio(&pcm(500, 0));
    h.session.commit();
    h.server.emit(json!({
        "type": "conversation.item.input_audio_transcription.failed",
        "item_id": "i1",
        "error": { "message": "audio unreadable" },
    }));
    settle(20).await;
    assert_eq!(
        h.signal.calls().last(),
        Some(&call(
            "error",
            Some("Transcription failed: audio unreadable")
        ))
    );
}

#[tokio::test]
async fn fails_the_start_when_the_upstream_rejects_the_configuration() {
    let h = harness(Limits::default()).await;
    h.server
        .emit(json!({ "type": "error", "error": { "message": "Invalid transcription model" } }));
    assert!(!h.started.await.unwrap());
    assert_eq!(
        h.signal.calls(),
        vec![call("error", Some("Invalid transcription model"))]
    );
}

#[tokio::test]
async fn reports_an_upstream_that_goes_away_mid_recording() {
    let h = harness(Limits::default()).await;
    h.accept();
    h.started.await.unwrap();
    h.server.drop_from_server();
    settle(40).await;
    assert_eq!(
        h.signal.calls().last(),
        Some(&call(
            "error",
            Some("The transcriber closed the connection (code 1011).")
        ))
    );
    assert_eq!(h.ended.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn gives_up_on_a_transcript_that_never_arrives() {
    let h = harness(Limits {
        result_timeout_ms: Some(50),
        ..Default::default()
    })
    .await;
    h.accept();
    h.started.await.unwrap();
    h.session.push_audio(&pcm(500, 0));
    h.session.commit();
    settle(250).await;
    assert_eq!(
        h.signal.calls().last(),
        Some(&call(
            "error",
            Some("The transcript did not arrive in time.")
        ))
    );
}

#[tokio::test]
async fn gives_up_on_an_upstream_that_never_accepts_the_configuration() {
    let h = harness(Limits {
        connect_timeout_ms: Some(50),
        ..Default::default()
    })
    .await;
    assert!(!h.started.await.unwrap());
    assert_eq!(
        h.signal.calls(),
        vec![call(
            "error",
            Some("The transcriber did not answer in time.")
        )]
    );
}
