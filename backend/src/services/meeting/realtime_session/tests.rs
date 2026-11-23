//! Protocol-level tests against a real local WebSocket server, so the frames the
//! session sends are checked as they'd go over the wire rather than through a mock.

use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use super::*;

/// Where a test session's tokens are spent.
fn spend() -> RealtimeSpend {
    RealtimeSpend {
        purpose: crate::services::meeting::realtime_usage::RealtimePurpose::Meeting,
        request_id: "call-1".into(),
        thread_id: None,
    }
}

impl Default for RealtimeSessionOptions {
    fn default() -> Self {
        RealtimeSessionOptions {
            instructions: String::new(),
            tools: Vec::new(),
            model: None,
            voice: None,
            agent_name: None,
            endpoint_override: None,
            spend: spend(),
        }
    }
}

enum Command {
    Emit(Value),
    Raw(String),
    Drop,
}

/// A local stand-in for the Realtime API: records every frame the client sends, and
/// sends what a test tells it to.
pub(crate) struct MockServer {
    pub port: u16,
    sent: Arc<Mutex<Vec<Value>>>,
    commands: mpsc::UnboundedSender<Command>,
    /// Frames a test told the server to send to the session.
    emitted: std::sync::atomic::AtomicUsize,
}

impl MockServer {
    /// Listen on a free port and serve the first connection.
    pub(crate) async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let sent = Arc::new(Mutex::new(Vec::new()));
        let (commands, mut rx) = mpsc::unbounded_channel::<Command>();
        let frames = sent.clone();
        tokio::spawn(async move {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
                return;
            };
            let (mut sink, mut stream) = ws.split();
            loop {
                tokio::select! {
                    message = stream.next() => match message {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(value) = serde_json::from_str::<Value>(text.as_str()) {
                                frames.lock().push(value);
                            }
                        }
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        Some(Ok(_)) => {}
                    },
                    command = rx.recv() => match command {
                        Some(Command::Emit(event)) => {
                            let _ = sink.send(Message::text(event.to_string())).await;
                        }
                        Some(Command::Raw(text)) => {
                            let _ = sink.send(Message::text(text)).await;
                        }
                        Some(Command::Drop) => {
                            let _ = sink
                                .send(Message::Close(Some(CloseFrame {
                                    code: CloseCode::Error,
                                    reason: "server gone".into(),
                                })))
                                .await;
                        }
                        None => break,
                    },
                }
            }
        });
        Self {
            port,
            sent,
            commands,
            emitted: Default::default(),
        }
    }

    pub(crate) fn endpoint(&self) -> RealtimeEndpoint {
        RealtimeEndpoint {
            url: format!("ws://127.0.0.1:{}", self.port),
            headers: IndexMap::new(),
            proxy_url: None,
        }
    }

    /// Push a server event to the session.
    pub(crate) fn emit(&self, event: Value) {
        if self.commands.send(Command::Emit(event)).is_ok() {
            self.emitted
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// Push a frame that is not JSON.
    pub(crate) fn emit_raw(&self, text: &str) {
        if self.commands.send(Command::Raw(text.to_string())).is_ok() {
            self.emitted
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// Close the socket from the server's side, as OpenAI would on a drop.
    pub(crate) fn drop_from_server(&self) {
        let _ = self.commands.send(Command::Drop);
    }

    /// Frames the session sent, parsed.
    pub(crate) fn sent(&self) -> Vec<Value> {
        self.sent.lock().clone()
    }
}

pub(crate) async fn settle() {
    tokio::time::sleep(Duration::from_millis(20)).await;
}

/// Wait until `check` holds, for up to 10 s, for a test that holds no session to sync
/// with: frames cross a real socket, so a fixed wait fails on a loaded host.
pub(crate) async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !check() {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// Wait until the session has handled every frame the server sent it and the server
/// holds every frame the session sent, for three checks in a row, since a handled
/// frame can make the session send another. A wall-clock wait instead fails when
/// the test suite loads the machine.
pub(crate) async fn sync(session: &RealtimeSession, server: &MockServer) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut balanced = 0;
    while balanced < 3 {
        assert!(
            std::time::Instant::now() < deadline,
            "the session and the server did not settle"
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
        let (sent, handled) = session.frame_counts();
        let emitted = server.emitted.load(std::sync::atomic::Ordering::SeqCst);
        let received = server.sent.lock().len();
        balanced = if sent == received && handled == emitted {
            balanced + 1
        } else {
            0
        };
    }
}

struct Harness {
    session: Arc<RealtimeSession>,
    server: MockServer,
}

impl Harness {
    /// Wait until every frame in flight either way has arrived and been handled.
    async fn sync(&self) {
        sync(&self.session, &self.server).await;
    }

    fn sent(&self) -> Vec<Value> {
        self.server.sent()
    }

    fn emit(&self, event: Value) {
        self.server.emit(event);
    }

    fn first(&self, kind: &str) -> Option<Value> {
        self.sent().into_iter().find(|f| f["type"] == kind)
    }

    fn all(&self, kind: &str) -> Vec<Value> {
        self.sent()
            .into_iter()
            .filter(|f| f["type"] == kind)
            .collect()
    }

    /// Requests the conversation made for itself.
    fn main_requests(&self) -> Vec<Value> {
        self.sent()
            .into_iter()
            .filter(|f| f["type"] == "response.create" && f.get("response").is_none())
            .collect()
    }

    /// The probe frame: the `response.create` that carries a `response` body.
    fn probe_frame(&self) -> Option<Value> {
        self.sent()
            .into_iter()
            .find(|f| f["type"] == "response.create" && f.get("response").is_some())
    }

    /// Answer a probe the way the server would, by the id it was opened with.
    fn answer_probe(&self, response_id: &str, text: &str) {
        self.emit(json!({
            "type": "response.done",
            "response": { "id": response_id, "status": "completed", "output": [{ "content": [{ "text": text }] }] },
        }));
    }

    fn update(&self) -> Value {
        self.first("session.update").expect("a session.update")
    }

    /// Every event the session raises from now on.
    fn record(&self) -> Arc<Mutex<Vec<RealtimeSessionEvent>>> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        self.session
            .on(Arc::new(move |event| sink.lock().push(event.clone())));
        events
    }
}

async fn harness_with(instructions: &str, tools: Vec<RealtimeFunctionTool>) -> Harness {
    let server = MockServer::start().await;
    let session = RealtimeSession::new(RealtimeSessionOptions {
        instructions: instructions.to_string(),
        tools,
        endpoint_override: Some(server.endpoint()),
        ..Default::default()
    });
    session.connect().await.unwrap();
    let harness = Harness { session, server };
    // Let the initial session.update land before a test inspects the frames.
    harness.sync().await;
    harness
}

async fn harness() -> Harness {
    harness_with("You are Prism.", Vec::new()).await
}

/// Base64 for `ms` of pcm16 @24kHz — lets a test emit a realistic amount of audio.
fn silence_delta(ms: u64) -> String {
    let samples = ((ms as f64 / 1000.0) * 24000.0).round() as usize;
    base64::engine::general_purpose::STANDARD.encode(vec![0u8; samples * 2])
}

fn snapshot(item_id: &str, played_ms: f64, sent_ms: f64) -> PlaybackSnapshot {
    PlaybackSnapshot {
        item_id: item_id.to_string(),
        played_ms,
        sent_ms,
    }
}

fn probe(deadline_ms: u64, item: &str) -> OutOfBandRequest {
    OutOfBandRequest {
        instructions: "gate".into(),
        input: Some(vec![json!({ "type": "item_reference", "id": item })]),
        deadline_ms,
        ..Default::default()
    }
}

/// Start a probe on its own task, so the test can drive the server while it waits.
fn spawn_probe(
    session: &Arc<RealtimeSession>,
    request: OutOfBandRequest,
) -> tokio::task::JoinHandle<Option<String>> {
    let session = session.clone();
    tokio::spawn(async move { session.request_out_of_band_text(request).await })
}

mod usage {
    use super::*;
    use crate::db::models::LlmCall;
    use crate::db::schema::llm_calls::dsl as l;
    use diesel::prelude::*;

    #[tokio::test]
    #[serial_test::serial]
    async fn records_the_usage_of_every_finished_response_and_transcription() {
        let _db = crate::db::testing::test_db();
        crate::services::memory_store::tests::ensure_agent(&CONFIG.agent_id().unwrap());
        let h = harness().await;
        let usage = json!({ "input_tokens": 120, "output_tokens": 40, "input_token_details": { "audio_tokens": 100 } });

        h.emit(json!({ "type": "response.done", "response": { "id": "resp-1", "status": "completed", "usage": usage } }));
        h.emit(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-1",
            "transcript": "hello",
            "usage": { "type": "tokens", "input_tokens": 30, "output_tokens": 2 },
        }));
        h.sync().await;

        let mut rows: Vec<LlmCall> = Vec::new();
        for _ in 0..100 {
            rows = crate::db::run(|conn| {
                Ok(l::llm_calls
                    .filter(l::request_id.eq("call-1"))
                    .order(l::input_tokens.desc())
                    .select(LlmCall::as_select())
                    .load(conn)?)
            })
            .await
            .unwrap();
            if rows.len() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let shown: Vec<(&str, &str, i64, i64, i64, Option<&str>, Option<&str>)> = rows
            .iter()
            .map(|r| {
                (
                    r.purpose.as_str(),
                    r.model.as_str(),
                    r.input_tokens,
                    r.output_tokens,
                    r.audio_input_tokens,
                    r.request_id.as_deref(),
                    r.source_kind.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            shown,
            vec![
                (
                    "meeting",
                    CONFIG.openai_realtime_model.as_str(),
                    120,
                    40,
                    100,
                    Some("call-1"),
                    Some("meeting")
                ),
                (
                    "meeting",
                    CONFIG.openai_transcription_model.as_str(),
                    30,
                    2,
                    0,
                    Some("call-1"),
                    Some("meeting")
                ),
            ]
        );
        h.session.close();
    }
}

mod configuration {
    use super::*;

    #[tokio::test]
    async fn configures_24khz_pcm16_both_ways_with_semantic_vad() {
        let h = harness().await;
        let update = h.update();
        let audio = &update["session"]["audio"];
        assert_eq!(
            audio["input"]["format"],
            json!({ "type": "audio/pcm", "rate": 24000 })
        );
        assert_eq!(
            audio["output"]["format"],
            json!({ "type": "audio/pcm", "rate": 24000 })
        );
        assert_eq!(audio["input"]["turn_detection"]["type"], "semantic_vad");
        assert_eq!(audio["input"]["turn_detection"]["eagerness"], "medium");
        h.session.close();
    }

    #[tokio::test]
    async fn asks_the_model_to_reason_before_it_answers_or_picks_a_tool() {
        set_settings_for_test(Some((Some("high"), "off")));
        let h = harness().await;
        assert_eq!(
            h.update()["session"]["reasoning"],
            json!({ "effort": "high" })
        );
        set_settings_for_test(None);
        h.session.close();
    }

    #[tokio::test]
    async fn sends_no_reasoning_block_when_the_level_is_handed_back_to_the_api() {
        set_settings_for_test(Some((None, "off")));
        let h = harness().await;
        assert!(h.update()["session"].get("reasoning").is_none());
        set_settings_for_test(None);
        h.session.close();
    }

    #[tokio::test]
    async fn never_lets_the_server_answer_or_interrupt_on_its_own() {
        let h = harness().await;
        let turn = &h.update()["session"]["audio"]["input"]["turn_detection"];
        assert_eq!(turn["create_response"], false);
        assert_eq!(turn["interrupt_response"], false);
        h.session.close();
    }

    #[tokio::test]
    async fn carries_the_agent_system_prompt_as_instructions() {
        let h = harness_with("# Identity\n\nYou are **Prism**.", Vec::new()).await;
        assert!(
            h.update()["session"]["instructions"]
                .as_str()
                .unwrap()
                .contains("You are **Prism**")
        );
        h.session.close();
    }

    #[tokio::test]
    async fn asks_for_no_transcription_when_the_words_will_not_be_written_down() {
        transcript_log::set_full_for_test(Some(false));
        let h = harness().await;
        assert!(
            h.update()["session"]["audio"]["input"]
                .get("transcription")
                .is_none()
        );
        transcript_log::set_full_for_test(None);
        h.session.close();
    }

    #[tokio::test]
    async fn transcribes_when_the_log_contains_the_words() {
        transcript_log::set_full_for_test(Some(true));
        let h = harness().await;
        // No language: a call can be in any language, and the transcriber detects it.
        assert_eq!(
            h.update()["session"]["audio"]["input"]["transcription"],
            json!({ "model": "gpt-realtime-whisper" })
        );
        transcript_log::set_full_for_test(None);
        h.session.close();
    }

    #[tokio::test]
    async fn sends_no_noise_reduction_key_by_default() {
        set_settings_for_test(Some((Some("high"), "off")));
        let h = harness().await;
        let input = &h.update()["session"]["audio"]["input"];
        assert!(input.get("noise_reduction").is_none());
        // The rest of the input config must survive the omission.
        assert_eq!(input["turn_detection"]["type"], "semantic_vad");
        set_settings_for_test(None);
        h.session.close();
    }

    #[tokio::test]
    async fn asks_for_reduction_when_an_operator_sets_one() {
        set_settings_for_test(Some((Some("high"), "far_field")));
        let h = harness().await;
        assert_eq!(
            h.update()["session"]["audio"]["input"]["noise_reduction"],
            json!({ "type": "far_field" })
        );
        set_settings_for_test(None);
        h.session.close();
    }

    #[tokio::test]
    async fn declares_the_agent_tools_as_function_tools() {
        let h = harness_with(
            "You are Prism.",
            vec![RealtimeFunctionTool {
                name: "list_scheduled_tasks".into(),
                description: "List tasks".into(),
                parameters: json!({ "type": "object", "properties": {} }),
            }],
        )
        .await;
        let update = h.update();
        assert_eq!(
            update["session"]["tools"],
            json!([{ "type": "function", "name": "list_scheduled_tasks", "description": "List tasks", "parameters": { "type": "object", "properties": {} } }])
        );
        assert_eq!(update["session"]["tool_choice"], "auto");
        h.session.close();
    }

    #[tokio::test]
    async fn omits_the_tools_block_entirely_when_there_are_none() {
        let h = harness().await;
        assert!(h.update()["session"].get("tools").is_none());
        h.session.close();
    }

    #[tokio::test]
    async fn sends_the_configuration_keys_in_order() {
        set_settings_for_test(Some((Some("high"), "off")));
        let h = harness().await;
        let session = h.update()["session"].clone();
        let keys: Vec<&str> = session
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "type",
                "instructions",
                "output_modalities",
                "reasoning",
                "audio"
            ]
        );
        set_settings_for_test(None);
        h.session.close();
    }
}

mod events {
    use super::*;

    #[tokio::test]
    async fn reports_a_committed_utterance_which_is_the_cue_to_decide_on_answering() {
        let h = harness().await;
        let events = h.record();
        h.emit(json!({ "type": "input_audio_buffer.committed", "item_id": "item-7" }));
        h.sync().await;
        let committed: Vec<String> = events
            .lock()
            .iter()
            .filter_map(|e| match e {
                RealtimeSessionEvent::UtteranceCommitted { item_id } => Some(item_id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(committed, vec!["item-7"]);
        h.session.close();
    }

    #[tokio::test]
    async fn tracks_spoken_turns_for_a_probe_tool_output_excluded() {
        let h = harness().await;
        let spoken = |id: &str| json!({ "id": id, "type": "message", "role": "user", "content": [{ "type": "input_audio" }] });
        h.emit(json!({ "type": "conversation.item.added", "item": spoken("u-1") }));
        h.emit(json!({ "type": "conversation.item.added", "item": { "id": "a-1", "type": "message", "role": "assistant" } }));
        h.emit(json!({ "type": "conversation.item.added", "item": { "id": "fc-1", "type": "function_call", "name": "shell_exec" } }));
        h.emit(json!({ "type": "conversation.item.added", "item": { "id": "fo-1", "type": "function_call_output", "call_id": "c1" } }));
        h.emit(json!({ "type": "conversation.item.added", "item": { "id": "ctx-1", "type": "message", "role": "user", "content": [{ "type": "input_text" }] } }));
        h.emit(json!({ "type": "conversation.item.added", "item": spoken("u-2") }));
        h.sync().await;

        assert_eq!(
            h.session.recent_conversation_items(10),
            vec!["u-1", "a-1", "u-2"]
        );
        // Oldest first, so a window takes the newest by slicing the tail.
        assert_eq!(h.session.recent_conversation_items(2), vec!["a-1", "u-2"]);
        assert!(h.session.recent_conversation_items(0).is_empty());
        h.session.close();
    }

    #[tokio::test]
    async fn does_not_record_the_same_turn_twice_when_both_item_events_arrive() {
        let h = harness().await;
        let turn = json!({ "id": "u-1", "type": "message", "role": "user", "content": [{ "type": "input_audio" }] });
        h.emit(json!({ "type": "conversation.item.added", "item": turn.clone() }));
        h.emit(json!({ "type": "conversation.item.created", "item": turn }));
        h.sync().await;
        assert_eq!(h.session.recent_conversation_items(10), vec!["u-1"]);
        h.session.close();
    }

    #[tokio::test]
    async fn emits_nothing_for_a_completed_transcription_with_no_text() {
        let h = harness().await;
        let events = h.record();
        h.emit(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-6",
            "transcript": "   ",
        }));
        h.emit(json!({
            "type": "conversation.item.input_audio_transcription.failed",
            "item_id": "item-8",
            "error": { "message": "audio too short" },
        }));
        h.sync().await;
        assert!(events.lock().is_empty());
        h.session.close();
    }

    #[tokio::test]
    async fn tags_a_transcript_with_the_item_it_belongs_to() {
        let h = harness().await;
        let events = h.record();
        h.emit(json!({
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item-7",
            "transcript": "  Prism, check the cluster  ",
        }));
        h.sync().await;
        let seen: Vec<(String, String)> = events
            .lock()
            .iter()
            .filter_map(|e| match e {
                RealtimeSessionEvent::Transcript { item_id, text } => {
                    Some((item_id.clone(), text.clone()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            seen,
            vec![("item-7".to_string(), "Prism, check the cluster".to_string())]
        );
        h.session.close();
    }

    fn audio(events: &Arc<Mutex<Vec<RealtimeSessionEvent>>>) -> Vec<(Bytes, String)> {
        events
            .lock()
            .iter()
            .filter_map(|e| match e {
                RealtimeSessionEvent::Audio { pcm, item_id } => {
                    Some((pcm.clone(), item_id.clone()))
                }
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn decodes_audio_deltas_to_pcm_buffers() {
        let h = harness().await;
        let events = h.record();
        let pcm = [0x01u8, 0x02, 0x03, 0x04];
        h.emit(json!({
            "type": "response.output_audio.delta",
            "delta": base64::engine::general_purpose::STANDARD.encode(pcm),
            "item_id": "item-1",
        }));
        h.sync().await;
        let received = audio(&events);
        assert_eq!(received.len(), 1);
        assert_eq!(received[0].0.as_ref(), &pcm);
        assert_eq!(received[0].1, "item-1");
        h.session.close();
    }

    #[tokio::test]
    async fn also_accepts_the_pre_ga_audio_event_name() {
        let h = harness().await;
        let events = h.record();
        h.emit(json!({
            "type": "response.audio.delta",
            "delta": base64::engine::general_purpose::STANDARD.encode([9u8, 9]),
            "item_id": "i",
        }));
        h.sync().await;
        assert_eq!(audio(&events).len(), 1);
        h.session.close();
    }

    #[tokio::test]
    async fn surfaces_speech_start_and_stop() {
        let h = harness().await;
        let events = h.record();
        h.emit(json!({ "type": "input_audio_buffer.speech_started" }));
        h.emit(json!({ "type": "input_audio_buffer.speech_stopped" }));
        h.sync().await;
        let seen: Vec<&str> = events
            .lock()
            .iter()
            .map(|e| match e {
                RealtimeSessionEvent::SpeechStarted => "start",
                RealtimeSessionEvent::SpeechStopped => "stop",
                _ => "other",
            })
            .collect();
        assert_eq!(seen, vec!["start", "stop"]);
        h.session.close();
    }

    #[tokio::test]
    async fn surfaces_a_finished_function_call() {
        let h = harness().await;
        let events = h.record();
        h.emit(json!({
            "type": "response.function_call_arguments.done",
            "call_id": "call-1",
            "name": "list_scheduled_tasks",
            "arguments": "{\"limit\":3}",
        }));
        h.sync().await;
        let calls: Vec<RealtimeFunctionCall> = events
            .lock()
            .iter()
            .filter_map(|e| match e {
                RealtimeSessionEvent::FunctionCall(call) => Some(call.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            calls,
            vec![RealtimeFunctionCall {
                call_id: "call-1".into(),
                name: "list_scheduled_tasks".into(),
                arguments_json: "{\"limit\":3}".into(),
            }]
        );
        h.session.close();
    }

    #[tokio::test]
    async fn ignores_a_malformed_function_call_rather_than_emitting_a_half_event() {
        let h = harness().await;
        let events = h.record();
        h.emit(json!({ "type": "response.function_call_arguments.done", "arguments": "{}" }));
        h.sync().await;
        assert!(events.lock().is_empty());
        h.session.close();
    }

    #[tokio::test]
    async fn reports_an_api_error_without_closing() {
        let h = harness().await;
        let events = h.record();
        h.emit(json!({ "type": "error", "error": { "message": "rate limited" } }));
        h.sync().await;
        let errors: Vec<String> = events
            .lock()
            .iter()
            .filter_map(|e| match e {
                RealtimeSessionEvent::ApiError { message } => Some(message.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(errors, vec!["rate limited"]);
        assert!(h.session.is_open());
        h.session.close();
    }

    #[tokio::test]
    async fn survives_an_unparseable_frame() {
        let h = harness().await;
        h.server.emit_raw("not json");
        h.emit(json!({ "type": "session.updated" }));
        h.sync().await;
        assert!(h.session.is_open());
        h.session.close();
    }

    #[tokio::test]
    async fn reports_a_close_the_server_initiated() {
        let h = harness().await;
        let events = h.record();
        h.server.drop_from_server();
        h.sync().await;
        h.sync().await;
        let closed: Vec<String> = events
            .lock()
            .iter()
            .filter_map(|e| match e {
                RealtimeSessionEvent::Closed { reason } => Some(reason.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(closed, vec!["server gone"]);
        assert!(!h.session.is_open());
    }
}

mod outbound {
    use super::*;

    #[tokio::test]
    async fn base64_encodes_appended_audio() {
        let h = harness().await;
        h.session.send_audio(&[0x10, 0x20]);
        h.sync().await;
        let append = h.first("input_audio_buffer.append").unwrap();
        assert_eq!(
            append["audio"],
            base64::engine::general_purpose::STANDARD.encode([0x10u8, 0x20])
        );
        h.session.close();
    }

    #[tokio::test]
    async fn skips_an_empty_audio_buffer() {
        let h = harness().await;
        h.session.send_audio(&[]);
        h.sync().await;
        assert!(h.all("input_audio_buffer.append").is_empty());
        h.session.close();
    }

    #[tokio::test]
    async fn truncates_the_spoken_item_at_what_was_actually_heard() {
        let h = harness().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "resp-1" } }));
        h.emit(json!({ "type": "response.output_audio.delta", "delta": silence_delta(2000), "item_id": "item-7", "response_id": "resp-1" }));
        h.sync().await;

        h.session.interrupt(&[snapshot("item-7", 1234.6, 2000.0)]);
        h.sync().await;

        assert!(h.first("response.cancel").is_some());
        let truncate = h.first("conversation.item.truncate").unwrap();
        assert_eq!(truncate["item_id"], "item-7");
        assert_eq!(truncate["content_index"], 0);
        // played + 50ms of slack, per OpenAI's transport.
        assert_eq!(truncate["audio_end_ms"], 1284);
        h.session.close();
    }

    #[tokio::test]
    async fn truncates_every_audio_item_of_an_interrupted_turn() {
        let h = harness().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "resp-1" } }));
        h.emit(json!({ "type": "response.output_audio.delta", "delta": silence_delta(1000), "item_id": "preamble", "response_id": "resp-1" }));
        h.emit(json!({ "type": "response.output_audio.delta", "delta": silence_delta(1000), "item_id": "answer", "response_id": "resp-1" }));
        h.sync().await;

        h.session.interrupt(&[
            // A fully-played preamble: sent == played, so the slack is clamped away.
            snapshot("preamble", 800.0, 800.0),
            snapshot("answer", 120.0, 1000.0),
        ]);
        h.sync().await;

        let truncates = h.all("conversation.item.truncate");
        assert_eq!(truncates.len(), 2);
        assert_eq!(truncates[0]["item_id"], "preamble");
        assert_eq!(truncates[0]["audio_end_ms"], 800);
        assert_eq!(truncates[1]["item_id"], "answer");
        assert_eq!(truncates[1]["audio_end_ms"], 170);
        h.session.close();
    }

    #[tokio::test]
    async fn does_not_cancel_when_no_response_is_in_flight() {
        let h = harness().await;
        h.emit(
            json!({ "type": "response.output_audio.delta", "delta": "AAAA", "item_id": "item-8" }),
        );
        h.sync().await;
        h.session.interrupt(&[snapshot("item-8", 100.0, 100.0)]);
        h.sync().await;
        assert!(h.first("response.cancel").is_none());
        // The truncate still goes: the item exists even if generation finished.
        assert!(h.first("conversation.item.truncate").is_some());
        h.session.close();
    }

    #[tokio::test]
    async fn discards_audio_that_was_already_in_flight_when_the_interrupt_committed() {
        let h = harness().await;
        let events = h.record();
        h.emit(json!({ "type": "response.created", "response": { "id": "resp-1" } }));
        h.emit(json!({ "type": "response.output_audio.delta", "delta": "AAAA", "item_id": "item-1", "response_id": "resp-1" }));
        h.sync().await;
        assert_eq!(events.lock().len(), 1);

        h.session.interrupt(&[snapshot("item-1", 500.0, 500.0)]);
        h.emit(json!({ "type": "response.output_audio.delta", "delta": "BBBB", "item_id": "item-1", "response_id": "resp-1" }));
        // A *later item* of the same abandoned turn must be dropped too.
        h.emit(json!({ "type": "response.output_audio.delta", "delta": "CCCC", "item_id": "item-2", "response_id": "resp-1" }));
        h.sync().await;
        assert_eq!(events.lock().len(), 1);
        h.session.close();
    }

    #[tokio::test]
    async fn still_plays_the_next_turn_after_an_interrupt() {
        let h = harness().await;
        let events = h.record();
        h.emit(json!({ "type": "response.created", "response": { "id": "resp-1" } }));
        h.emit(json!({ "type": "response.output_audio.delta", "delta": "AAAA", "item_id": "item-1", "response_id": "resp-1" }));
        h.sync().await;
        h.session.interrupt(&[snapshot("item-1", 100.0, 100.0)]);

        h.emit(json!({ "type": "response.created", "response": { "id": "resp-2" } }));
        h.emit(json!({ "type": "response.output_audio.delta", "delta": "DDDD", "item_id": "item-2", "response_id": "resp-2" }));
        h.sync().await;

        let items: Vec<String> = events
            .lock()
            .iter()
            .filter_map(|e| match e {
                RealtimeSessionEvent::Audio { item_id, .. } => Some(item_id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(items, vec!["item-1", "item-2"]);
        h.session.close();
    }

    #[tokio::test]
    async fn caps_audio_end_ms_at_what_the_server_actually_generated() {
        let h = harness().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "resp-1" } }));
        // 8 base64 chars -> 6 bytes -> 3 samples -> ~0.125ms of generated audio.
        h.emit(json!({ "type": "response.output_audio.delta", "delta": "AAAAAAAA", "item_id": "item-x", "response_id": "resp-1" }));
        h.sync().await;
        h.session
            .interrupt(&[snapshot("item-x", 99_999.0, 99_999.0)]);
        h.sync().await;
        let truncate = h.first("conversation.item.truncate").unwrap();
        assert!(truncate["audio_end_ms"].as_i64().unwrap() < 10);
        h.session.close();
    }

    #[tokio::test]
    async fn truncates_an_item_that_never_started_at_zero() {
        let h = harness().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "resp-1" } }));
        h.emit(json!({ "type": "response.output_audio.delta", "delta": silence_delta(500), "item_id": "heard", "response_id": "resp-1" }));
        h.emit(json!({ "type": "response.output_audio.delta", "delta": silence_delta(500), "item_id": "unheard", "response_id": "resp-1" }));
        h.sync().await;
        h.session.interrupt(&[
            snapshot("heard", 300.0, 300.0),
            snapshot("unheard", 0.0, 0.0),
        ]);
        h.sync().await;
        let truncates = h.all("conversation.item.truncate");
        assert_eq!(truncates[1]["item_id"], "unheard");
        assert_eq!(truncates[1]["audio_end_ms"], 0);
        h.session.close();
    }

    #[tokio::test]
    async fn sends_nothing_when_there_is_nothing_left_to_truncate() {
        let h = harness().await;
        h.emit(
            json!({ "type": "response.output_audio.delta", "delta": "AAAA", "item_id": "item-9" }),
        );
        h.sync().await;
        h.session.interrupt(&[snapshot("item-9", 100.0, 100.0)]);
        h.session.interrupt(&[]);
        h.sync().await;
        assert_eq!(h.all("conversation.item.truncate").len(), 1);
        h.session.close();
    }

    #[tokio::test]
    async fn follows_a_tool_result_with_an_explicit_response_request() {
        let h = harness().await;
        h.session.send_function_output("call-1", "{\"ok\":true}");
        h.sync().await;
        let item = h.first("conversation.item.create").unwrap();
        assert_eq!(
            item["item"],
            json!({ "type": "function_call_output", "call_id": "call-1", "output": "{\"ok\":true}" })
        );
        assert!(h.first("response.create").is_some());
        h.session.close();
    }

    #[tokio::test]
    async fn defers_a_response_request_until_the_open_response_finishes() {
        let h = harness().await;
        h.emit(json!({ "type": "response.created" }));
        h.sync().await;
        h.session.send_function_output("call-1", "{\"ok\":true}");
        h.sync().await;
        assert!(h.all("response.create").is_empty());

        h.emit(json!({ "type": "response.done" }));
        h.sync().await;
        assert_eq!(h.all("response.create").len(), 1);
        h.session.close();
    }

    #[tokio::test]
    async fn abandons_a_deferred_response_when_a_human_takes_the_floor() {
        let h = harness().await;
        h.emit(json!({ "type": "response.created" }));
        h.emit(json!({ "type": "response.output_audio.delta", "delta": "AAAA", "item_id": "i-1" }));
        h.sync().await;
        h.session.send_function_output("call-1", "{\"ok\":true}");
        h.session.interrupt(&[snapshot("i-1", 200.0, 200.0)]);
        h.emit(json!({ "type": "response.done" }));
        h.sync().await;
        assert!(h.all("response.create").is_empty());
        h.session.close();
    }

    #[tokio::test]
    async fn injects_context_as_a_user_message() {
        let h = harness().await;
        h.session.send_context("You have just been admitted.");
        h.sync().await;
        let item = h.first("conversation.item.create").unwrap();
        assert_eq!(item["item"]["role"], "user");
        assert_eq!(
            item["item"]["content"][0]["text"],
            "You have just been admitted."
        );
        h.session.close();
    }

    #[tokio::test]
    async fn sends_a_screenshot_as_an_image_item_nobody_said() {
        let h = harness().await;
        h.session
            .send_image("data:image/jpeg;base64,AAAA", "This is your screen.");
        h.sync().await;
        let item = h.first("conversation.item.create").unwrap();
        assert_eq!(item["item"]["type"], "message");
        assert_eq!(item["item"]["role"], "user");
        assert_eq!(
            item["item"]["content"],
            json!([
                { "type": "input_image", "image_url": "data:image/jpeg;base64,AAAA" },
                { "type": "input_text", "text": "This is your screen." },
            ])
        );
        h.session.close();
    }

    #[tokio::test]
    async fn sends_a_recording_as_one_item_per_window_each_labelled_beside_its_audio() {
        let h = harness().await;
        h.session.send_recording(
            &[
                RecordingSegment {
                    label: "0:00".into(),
                    images: vec!["data:image/jpeg;base64,AAAA".into()],
                    audio: Bytes::from_static(&[1, 2, 3, 4]),
                },
                RecordingSegment {
                    label: "0:30".into(),
                    images: vec![],
                    audio: Bytes::from_static(&[5, 6]),
                },
            ],
            "Your user recorded their screen.",
        );
        h.sync().await;
        let items = h.all("conversation.item.create");
        assert_eq!(items.len(), 3);
        assert_eq!(
            items[0]["item"]["content"],
            json!([{ "type": "input_text", "text": "Your user recorded their screen." }])
        );
        assert_eq!(items[1]["item"]["role"], "user");
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        assert_eq!(
            items[1]["item"]["content"],
            json!([
                { "type": "input_text", "text": "At 0:00:" },
                { "type": "input_image", "image_url": "data:image/jpeg;base64,AAAA" },
                { "type": "input_audio", "audio": b64(&[1, 2, 3, 4]) },
            ])
        );
        assert_eq!(
            items[2]["item"]["content"],
            json!([
                { "type": "input_text", "text": "At 0:30:" },
                { "type": "input_audio", "audio": b64(&[5, 6]) },
            ])
        );
        h.session.close();
    }

    #[tokio::test]
    async fn keeps_a_recording_out_of_the_window_a_probe_re_reads() {
        let h = harness().await;
        h.emit(json!({ "type": "conversation.item.added", "item": { "id": "u-1", "type": "message", "role": "user", "content": [{ "type": "input_audio" }] } }));
        h.emit(json!({ "type": "conversation.item.added", "item": { "id": "rec-1", "type": "message", "role": "user", "content": [{ "type": "input_text" }, { "type": "input_image" }, { "type": "input_audio" }] } }));
        h.sync().await;
        assert_eq!(h.session.recent_conversation_items(10), vec!["u-1"]);
        h.session.close();
    }

    #[tokio::test]
    async fn drops_sends_after_close_instead_of_failing() {
        let h = harness().await;
        h.session.close();
        h.sync().await;
        h.session.send_audio(&[1, 2]);
        assert!(!h.session.is_open());
    }

    #[tokio::test]
    async fn sends_new_tools_as_a_partial_update() {
        let h = harness().await;
        h.session.set_tools(vec![RealtimeFunctionTool {
            name: "memory_search".into(),
            description: "Search".into(),
            parameters: json!({ "type": "object" }),
        }]);
        h.sync().await;
        let updates = h.all("session.update");
        assert_eq!(
            updates[1],
            json!({ "type": "session.update", "session": { "type": "realtime", "tools": [{ "type": "function", "name": "memory_search", "description": "Search", "parameters": { "type": "object" } }], "tool_choice": "auto" } })
        );
        h.session.close();
    }
}

mod connection_failure {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn reports_a_rejected_handshake_status_without_retrying() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let attempts = Arc::new(AtomicUsize::new(0));
        let counter = attempts.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer).await;
                let _ = stream
                    .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                    .await;
            }
        });
        let mut headers = IndexMap::new();
        headers.insert("Authorization".to_string(), "Bearer hidden-key".to_string());
        let session = RealtimeSession::new(RealtimeSessionOptions {
            instructions: "x".into(),
            endpoint_override: Some(RealtimeEndpoint {
                url: format!("ws://127.0.0.1:{port}/?secret=hidden"),
                headers,
                proxy_url: None,
            }),
            ..Default::default()
        });
        let err = session.connect().await.unwrap_err();
        assert!(
            err.to_string().contains("Unexpected server response: 403"),
            "{err}"
        );
        assert!(err.to_string().starts_with("Realtime connection failed: "));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        session.close();
    }

    #[tokio::test]
    async fn fails_with_a_clear_message_when_the_socket_cannot_open() {
        // Port 1 is reserved and refuses connections.
        let session = RealtimeSession::new(RealtimeSessionOptions {
            instructions: "x".into(),
            endpoint_override: Some(RealtimeEndpoint {
                url: "ws://127.0.0.1:1".into(),
                ..Default::default()
            }),
            ..Default::default()
        });
        let err = session.connect().await.unwrap_err();
        assert!(err.to_string().contains("Realtime connection failed"));
    }
}

/// A question asked beside the conversation, so the agent can be asked "was that
/// for you?" without the asking becoming something it said.
///
/// The risk these cover is not the frame — it is that a second response now exists
/// on a session whose bookkeeping was written for exactly one.
mod probes {
    use super::*;

    #[tokio::test]
    async fn asks_out_of_band_out_of_conversation_and_without_tools() {
        let h = harness().await;
        let mut metadata = IndexMap::new();
        metadata.insert("purpose".to_string(), "addressed-gate".to_string());
        let verdict = spawn_probe(
            &h.session,
            OutOfBandRequest {
                instructions: "Answer YES or NO.".into(),
                input: Some(vec![json!({ "type": "item_reference", "id": "item-7" })]),
                metadata: Some(metadata),
                deadline_ms: 500,
                max_output_tokens: Some(16),
                reasoning_effort: Some("low".into()),
            },
        );
        h.sync().await;

        let frame = h.probe_frame().unwrap();
        let response = &frame["response"];
        assert_eq!(response["conversation"], "none");
        assert_eq!(response["output_modalities"], json!(["text"]));
        assert_eq!(response["instructions"], "Answer YES or NO.");
        assert_eq!(
            response["input"],
            json!([{ "type": "item_reference", "id": "item-7" }])
        );
        assert_eq!(response["max_output_tokens"], 16);
        assert_eq!(response["reasoning"], json!({ "effort": "low" }));
        assert_eq!(response["tools"], json!([]));
        assert_eq!(response["tool_choice"], "none");
        assert_eq!(response["metadata"]["purpose"], "addressed-gate");
        assert_eq!(response["metadata"]["prism_oob"], frame["event_id"]);
        let keys: Vec<&str> = response
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "conversation",
                "output_modalities",
                "instructions",
                "metadata",
                "tools",
                "tool_choice",
                "reasoning",
                "max_output_tokens",
                "input"
            ]
        );

        h.emit(json!({ "type": "response.created", "response": { "id": "r-probe" } }));
        h.sync().await;
        h.answer_probe("r-probe", "YES");
        assert_eq!(verdict.await.unwrap().as_deref(), Some("YES"));
        h.session.close();
    }

    #[tokio::test]
    async fn matches_a_verdict_by_its_echoed_marker_when_the_open_event_was_missed() {
        let h = harness().await;
        let verdict = spawn_probe(&h.session, probe(500, "i-1"));
        h.sync().await;
        let send_id = h.probe_frame().unwrap()["event_id"].clone();
        h.emit(json!({
            "type": "response.done",
            "response": { "id": "r-unseen", "status": "completed", "metadata": { "prism_oob": send_id }, "output": [{ "content": [{ "text": "YES" }] }] },
        }));
        assert_eq!(verdict.await.unwrap().as_deref(), Some("YES"));
        h.session.close();
    }

    #[tokio::test]
    async fn reads_a_verdict_that_arrives_only_as_deltas() {
        let h = harness().await;
        let verdict = spawn_probe(&h.session, probe(500, "i-1"));
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-probe" } }));
        h.emit(json!({ "type": "response.output_text.delta", "response_id": "r-probe", "delta": "NO" }));
        h.emit(json!({ "type": "response.done", "response": { "id": "r-probe", "status": "completed" } }));
        assert_eq!(verdict.await.unwrap().as_deref(), Some("NO"));
        h.session.close();
    }

    #[tokio::test]
    async fn does_not_let_a_probe_finishing_release_the_conversation_slot() {
        let h = harness().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-main" } }));
        h.sync().await;
        let verdict = spawn_probe(&h.session, probe(500, "i-1"));
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-probe" } }));
        h.sync().await;

        h.session.send_function_output("call-1", "{\"ok\":true}");
        h.sync().await;
        assert!(h.main_requests().is_empty());

        h.answer_probe("r-probe", "YES");
        assert_eq!(verdict.await.unwrap().as_deref(), Some("YES"));
        h.sync().await;
        assert!(h.main_requests().is_empty());

        h.emit(json!({ "type": "response.done", "response": { "id": "r-main", "status": "completed" } }));
        h.sync().await;
        assert_eq!(h.main_requests().len(), 1);
        h.session.close();
    }

    #[tokio::test]
    async fn does_not_count_a_probe_as_a_response_the_room_heard() {
        let h = harness().await;
        let events = h.record();
        let verdict = spawn_probe(&h.session, probe(500, "i-1"));
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-probe" } }));
        h.answer_probe("r-probe", "NO");
        verdict.await.unwrap();
        assert!(
            !events
                .lock()
                .iter()
                .any(|e| matches!(e, RealtimeSessionEvent::ResponseDone))
        );
        h.session.close();
    }

    #[tokio::test]
    async fn cancels_the_speaking_turn_by_id_leaving_a_probe_in_flight_alone() {
        let h = harness().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-main" } }));
        h.emit(json!({ "type": "response.output_audio.delta", "delta": silence_delta(200), "item_id": "i-1" }));
        h.sync().await;
        let verdict = spawn_probe(&h.session, probe(500, "i-2"));
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-probe" } }));
        h.sync().await;

        h.session.interrupt(&[snapshot("i-1", 100.0, 200.0)]);
        h.sync().await;
        assert_eq!(h.first("response.cancel").unwrap()["response_id"], "r-main");

        let events = h.record();
        h.emit(json!({ "type": "response.output_audio.delta", "delta": "AAAA", "item_id": "i-1", "response_id": "r-main" }));
        h.sync().await;
        assert!(events.lock().is_empty());

        h.answer_probe("r-probe", "YES");
        assert_eq!(verdict.await.unwrap().as_deref(), Some("YES"));
        h.session.close();
    }

    #[tokio::test]
    async fn keeps_two_probes_apart_when_the_model_answers_them_out_of_order() {
        let h = harness().await;
        let first = spawn_probe(&h.session, probe(500, "i-1"));
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-1" } }));
        h.sync().await;
        let second = spawn_probe(&h.session, probe(500, "i-2"));
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-2" } }));
        h.sync().await;

        h.answer_probe("r-2", "YES");
        h.answer_probe("r-1", "NO");
        assert_eq!(first.await.unwrap().as_deref(), Some("NO"));
        assert_eq!(second.await.unwrap().as_deref(), Some("YES"));
        h.session.close();
    }

    #[tokio::test]
    async fn gives_up_on_a_probe_the_server_never_answers_and_ignores_a_late_verdict() {
        let h = harness().await;
        let verdict = spawn_probe(&h.session, probe(40, "i-1"));
        h.emit(json!({ "type": "response.created", "response": { "id": "r-probe" } }));
        assert_eq!(verdict.await.unwrap(), None);
        h.answer_probe("r-probe", "YES");
        h.sync().await;
        assert!(h.session.is_open());
        h.session.close();
    }

    #[tokio::test]
    async fn fails_a_rejected_probe_by_its_event_id_without_touching_the_conversation() {
        let h = harness().await;
        let verdict = spawn_probe(&h.session, probe(500, "i-1"));
        h.sync().await;
        let send_id = h.probe_frame().unwrap()["event_id"].clone();
        h.emit(json!({
            "type": "error",
            "event_id": "event_server_side",
            "error": { "message": "Conversation already has an active response in progress", "event_id": send_id },
        }));
        assert_eq!(verdict.await.unwrap(), None);

        h.session.request_response();
        h.sync().await;
        assert_eq!(h.main_requests().len(), 1);
        h.session.close();
    }

    #[tokio::test]
    async fn never_executes_a_tool_call_arriving_on_a_probe() {
        let h = harness().await;
        let events = h.record();
        let verdict = spawn_probe(&h.session, probe(500, "i-1"));
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-probe" } }));
        h.sync().await;
        h.emit(json!({
            "type": "response.function_call_arguments.done",
            "response_id": "r-probe",
            "call_id": "call-1",
            "name": "shell_exec",
            "arguments": "{\"command\":\"rm -rf /\"}",
        }));
        h.sync().await;
        assert!(
            !events
                .lock()
                .iter()
                .any(|e| matches!(e, RealtimeSessionEvent::FunctionCall(_)))
        );
        h.answer_probe("r-probe", "NO");
        verdict.await.unwrap();
        h.session.close();
    }

    #[tokio::test]
    async fn attributes_an_opened_response_correctly_when_metadata_is_not_echoed() {
        let h = harness().await;
        h.session.request_response();
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-main" } }));
        h.sync().await;

        let verdict = spawn_probe(&h.session, probe(500, "i-1"));
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-probe" } }));
        h.emit(json!({ "type": "response.output_text.delta", "response_id": "r-probe", "delta": "YES" }));
        h.emit(json!({ "type": "response.done", "response": { "id": "r-probe", "status": "completed" } }));
        assert_eq!(verdict.await.unwrap().as_deref(), Some("YES"));

        h.session.interrupt(&[]);
        h.sync().await;
        assert_eq!(h.first("response.cancel").unwrap()["response_id"], "r-main");
        h.session.close();
    }

    #[tokio::test]
    async fn ignores_a_completion_for_a_response_that_is_no_longer_the_live_one() {
        let h = harness().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-a" } }));
        h.emit(json!({ "type": "response.output_audio.delta", "delta": silence_delta(200), "item_id": "i-1" }));
        h.sync().await;

        h.session.interrupt(&[snapshot("i-1", 100.0, 200.0)]);
        h.session.request_response();
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-b" } }));
        h.sync().await;

        h.emit(
            json!({ "type": "response.done", "response": { "id": "r-a", "status": "cancelled" } }),
        );
        h.sync().await;

        let before = h.all("response.cancel").len();
        h.session.interrupt(&[]);
        h.sync().await;
        let cancels = h.all("response.cancel");
        assert_eq!(cancels.len(), before + 1);
        assert_eq!(cancels.last().unwrap()["response_id"], "r-b");
        h.session.close();
    }

    #[tokio::test]
    async fn keeps_a_live_response_when_a_cancel_reports_nothing_to_cancel() {
        let h = harness().await;
        h.session.request_response();
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-live" } }));
        h.sync().await;
        h.emit(json!({ "type": "error", "error": { "message": "Cancellation failed: no active response" } }));
        h.sync().await;
        h.session.interrupt(&[]);
        h.sync().await;
        assert_eq!(h.first("response.cancel").unwrap()["response_id"], "r-live");
        h.session.close();
    }

    #[tokio::test]
    async fn still_recognises_a_rejection_for_a_probe_that_has_already_given_up() {
        let h = harness().await;
        let verdict = spawn_probe(&h.session, probe(40, "i-1"));
        h.sync().await;
        let send_id = h.probe_frame().unwrap()["event_id"].clone();
        assert_eq!(verdict.await.unwrap(), None);

        h.emit(json!({
            "type": "error",
            "error": { "message": "Conversation already has an active response in progress", "event_id": send_id },
        }));
        h.sync().await;

        let before = h.main_requests().len();
        h.session.request_response();
        h.sync().await;
        assert_eq!(h.main_requests().len(), before + 1);
        h.session.close();
    }

    #[tokio::test]
    async fn keeps_a_probe_attributable_for_longer_than_the_conversation_waits() {
        let h = harness().await;
        let verdict = spawn_probe(&h.session, probe(8_000, "i-1"));
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-probe" } }));
        h.emit(json!({ "type": "response.output_text.delta", "response_id": "r-probe", "delta": "YES" }));
        h.emit(json!({ "type": "response.done", "response": { "id": "r-probe", "status": "completed" } }));
        assert_eq!(verdict.await.unwrap().as_deref(), Some("YES"));
        h.session.close();
    }

    #[tokio::test]
    async fn answers_null_when_a_probe_completes_with_nothing_to_say() {
        let h = harness().await;
        let verdict = spawn_probe(&h.session, probe(500, "i-1"));
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-probe" } }));
        h.sync().await;
        h.emit(json!({
            "type": "response.done",
            "response": {
                "id": "r-probe",
                "status": "incomplete",
                "status_details": { "reason": "max_output_tokens" },
                "usage": { "output_token_details": { "reasoning_tokens": 64, "text_tokens": 0 } },
                "output": [],
            },
        }));
        assert_eq!(verdict.await.unwrap(), None);
        h.session.close();
    }

    #[tokio::test]
    async fn resolves_a_probe_left_in_flight_when_the_call_ends() {
        let h = harness().await;
        let verdict = spawn_probe(&h.session, probe(10_000, "i-1"));
        h.sync().await;
        h.session.close();
        assert_eq!(verdict.await.unwrap(), None);
    }

    #[tokio::test]
    async fn answers_null_rather_than_hanging_when_the_socket_is_already_shut() {
        let h = harness().await;
        h.session.close();
        let before = h.sent().len();
        let answer = h
            .session
            .request_out_of_band_text(OutOfBandRequest {
                instructions: "gate".into(),
                deadline_ms: 10_000,
                ..Default::default()
            })
            .await;
        assert_eq!(answer, None);
        h.sync().await;
        assert_eq!(h.sent().len(), before);
    }

    #[tokio::test]
    async fn places_two_responses_opening_at_once_by_the_order_they_were_asked_for() {
        let h = harness().await;
        let verdict = spawn_probe(&h.session, probe(500, "i-2"));
        // Let the probe's frame go out before the conversation's.
        tokio::task::yield_now().await;
        h.sync().await;
        h.session.request_response();
        h.sync().await;

        h.emit(json!({ "type": "response.created", "response": { "id": "r-probe" } }));
        h.emit(json!({ "type": "response.created", "response": { "id": "r-main" } }));
        h.sync().await;

        h.session.interrupt(&[]);
        h.sync().await;
        assert_eq!(h.first("response.cancel").unwrap()["response_id"], "r-main");

        h.answer_probe("r-probe", "YES");
        assert_eq!(verdict.await.unwrap().as_deref(), Some("YES"));

        h.emit(json!({ "type": "response.done", "response": { "id": "r-main", "status": "completed" } }));
        h.sync().await;
        let before = h.main_requests().len();
        h.session.request_response();
        h.sync().await;
        assert_eq!(h.main_requests().len(), before + 1);
        h.session.close();
    }

    #[tokio::test]
    async fn forgets_a_rejected_conversation_request_so_it_cannot_misplace_a_later_one() {
        let h = harness().await;
        h.session.request_response();
        h.sync().await;
        let rejected = h.main_requests()[0]["event_id"].clone();
        h.emit(json!({
            "type": "error",
            "event_id": "event_server_side",
            "error": { "message": "Conversation already has an active response in progress", "event_id": rejected },
        }));
        h.sync().await;

        let verdict = spawn_probe(&h.session, probe(500, "i-1"));
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-probe" } }));
        h.emit(json!({ "type": "response.output_text.delta", "response_id": "r-probe", "delta": "NO" }));
        h.emit(json!({ "type": "response.done", "response": { "id": "r-probe", "status": "completed" } }));
        assert_eq!(verdict.await.unwrap().as_deref(), Some("NO"));
        h.session.close();
    }

    #[tokio::test]
    async fn never_plays_audio_that_arrives_on_a_probe() {
        let h = harness().await;
        let events = h.record();
        let verdict = spawn_probe(&h.session, probe(500, "i-1"));
        h.sync().await;
        h.emit(json!({ "type": "response.created", "response": { "id": "r-probe" } }));
        h.sync().await;
        h.emit(json!({ "type": "response.output_audio.delta", "delta": silence_delta(100), "item_id": "i-x", "response_id": "r-probe" }));
        h.sync().await;
        assert!(events.lock().is_empty());
        h.answer_probe("r-probe", "NO");
        verdict.await.unwrap();
        h.session.close();
    }

    #[tokio::test]
    async fn still_refuses_a_tool_call_on_a_probe_that_has_already_given_up() {
        let h = harness().await;
        let events = h.record();
        let verdict = spawn_probe(&h.session, probe(40, "i-1"));
        h.emit(json!({ "type": "response.created", "response": { "id": "r-probe" } }));
        assert_eq!(verdict.await.unwrap(), None);
        h.emit(json!({
            "type": "response.function_call_arguments.done",
            "response_id": "r-probe",
            "call_id": "call-1",
            "name": "shell_exec",
            "arguments": "{\"command\":\"rm -rf /\"}",
        }));
        h.sync().await;
        assert!(events.lock().is_empty());
        h.session.close();
    }

    #[tokio::test]
    async fn does_not_let_a_response_we_know_is_out_of_band_claim_the_conversation_slot() {
        let h = harness().await;
        let verdict = spawn_probe(&h.session, probe(200, "i-1"));
        h.sync().await;
        let send_id = h.probe_frame().unwrap()["event_id"].clone();
        assert_eq!(verdict.await.unwrap(), None);

        h.emit(json!({ "type": "response.created", "response": { "id": "r-late", "metadata": { "prism_oob": send_id } } }));
        h.sync().await;
        let before = h.main_requests().len();
        h.session.request_response();
        h.sync().await;
        assert_eq!(h.main_requests().len(), before + 1);
        h.session.close();
    }

    #[tokio::test]
    async fn settles_a_probe_when_the_server_drops_the_socket() {
        let h = harness().await;
        let verdict = spawn_probe(&h.session, probe(10_000, "i-1"));
        h.sync().await;
        h.server.drop_from_server();
        let answer = tokio::time::timeout(Duration::from_secs(5), verdict)
            .await
            .expect("settled before its deadline")
            .unwrap();
        assert_eq!(answer, None);
    }
}

#[test]
fn decodes_base64_the_way_node_does() {
    assert_eq!(decode_base64_lenient("AAAA"), vec![0, 0, 0]);
    assert_eq!(decode_base64_lenient("AQID"), vec![1, 2, 3]);
    assert_eq!(decode_base64_lenient("AQI"), vec![1, 2]);
    assert_eq!(decode_base64_lenient("AQ=="), vec![1]);
}
