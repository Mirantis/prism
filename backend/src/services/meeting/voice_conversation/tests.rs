//! The conversation over a real local WebSocket server, so the frames that put the
//! agent's voice in the room are checked as they go over the wire.

use std::time::Duration;

use serde_json::{Value, json};

use super::*;
use crate::services::meeting::meeting_provider_interface::SpeakerDetails;
use crate::services::meeting::realtime_session::tests::{MockServer, eventually, settle};
use crate::services::meeting::transcript_log;

struct NullSink;

impl PlaybackSink for NullSink {
    fn write(&self, _chunk: Bytes) -> anyhow::Result<()> {
        Ok(())
    }
}

fn no_tools() -> PreparedTools {
    PreparedTools {
        declarations: Arc::new(|| Arc::new(Vec::new())),
        count: 0,
        execute: Arc::new(|_name: String, _args: String| async { String::new() }.boxed()),
        catalog: None,
    }
}

fn options(server: &MockServer, sample_rate: u32) -> VoiceConversationOptions {
    VoiceConversationOptions {
        on_response_finished: None,
        instructions: "You are Emma.".into(),
        opening_context: None,
        tools: no_tools(),
        sink: Arc::new(NullSink),
        sample_rate,
        // Named, so every utterance goes to the gate rather than being answered outright.
        response_mode: ResponseMode::Addressed,
        agent_name: "Emma".into(),
        model: None,
        voice: None,
        endpoint_override: Some(server.endpoint()),
        on_session_lost: None,
    }
}

struct Harness {
    conversation: Arc<VoiceConversation>,
    server: MockServer,
    lost: Arc<Mutex<Vec<String>>>,
}

impl Harness {
    fn sent(&self) -> Vec<Value> {
        self.server.sent()
    }

    fn of_type(&self, kind: &str) -> Vec<Value> {
        self.sent()
            .into_iter()
            .filter(|f| f["type"] == kind)
            .collect()
    }

    /// Requests the conversation made for itself — the ones that put the agent's voice
    /// in the room.
    fn spoken_requests(&self) -> Vec<Value> {
        self.sent()
            .into_iter()
            .filter(|f| f["type"] == "response.create" && f.get("response").is_none())
            .collect()
    }

    fn probes(&self) -> Vec<Value> {
        self.sent()
            .into_iter()
            .filter(|f| f["type"] == "response.create" && f.get("response").is_some())
            .collect()
    }

    /// Answer the newest probe the client has sent, the way the server would.
    async fn answer_gate(&self, verdict: &str) {
        let probe = self.probes().pop().expect("the gate was asked");
        let metadata = probe["response"]["metadata"].clone();
        self.server.emit(json!({ "type": "response.created", "response": { "id": "r-gate", "metadata": metadata } }));
        self.server.emit(json!({
            "type": "response.done",
            "response": { "id": "r-gate", "status": "completed", "output": [{ "content": [{ "text": verdict }] }] },
        }));
        settle().await;
        settle().await;
    }

    fn commit(&self, item_id: &str) {
        self.server
            .emit(json!({ "type": "input_audio_buffer.committed", "item_id": item_id }));
    }
}

async fn harness_with(
    sample_rate: u32,
    change: impl FnOnce(&mut VoiceConversationOptions),
) -> Harness {
    let server = MockServer::start().await;
    let lost = Arc::new(Mutex::new(Vec::new()));
    let mut options = options(&server, sample_rate);
    let record = lost.clone();
    options.on_session_lost = Some(Arc::new(move |reason: String| record.lock().push(reason)));
    change(&mut options);
    let conversation = VoiceConversation::new(options).unwrap();
    conversation.start().await.unwrap();
    settle().await;
    Harness {
        conversation,
        server,
        lost,
    }
}

async fn harness() -> Harness {
    harness_with(MEETING_SAMPLE_RATE, |_| {}).await
}

fn reading(name: &str) -> SpeakerReading {
    SpeakerReading {
        id: format!("devices/{name}"),
        is_self: false,
        who: SpeakerDetails::Person { name: name.into() },
    }
}

const OPENING: &str =
    "\n\nContext:\n<recent-memories>\n- Paused the deploy (decision)\n</recent-memories>";

#[tokio::test]
async fn sends_the_opening_context_once_as_a_user_item_after_the_configuration() {
    let h = harness_with(MEETING_SAMPLE_RATE, |o| {
        o.opening_context = Some(OPENING.into())
    })
    .await;
    eventually("the opening context", || {
        h.sent()
            .iter()
            .any(|f| f["type"] == "conversation.item.create")
    })
    .await;
    // A second copy would follow at once; it is given the time to.
    settle().await;
    let types: Vec<String> = h
        .sent()
        .iter()
        .map(|f| f["type"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        types
            .iter()
            .filter(|t| *t == "conversation.item.create")
            .count(),
        1
    );
    let item = types
        .iter()
        .position(|t| t == "conversation.item.create")
        .unwrap();
    let update = types.iter().position(|t| t == "session.update").unwrap();
    assert!(item > update);
    assert_eq!(
        h.of_type("conversation.item.create")[0],
        json!({
            "type": "conversation.item.create",
            "item": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": OPENING }] },
        })
    );
    h.conversation.stop();
}

#[tokio::test]
async fn sends_no_item_when_there_is_nothing_to_open_with() {
    let h = harness().await;
    assert!(h.of_type("conversation.item.create").is_empty());
    h.conversation.stop();
}

#[tokio::test]
async fn appends_the_tool_catalog_to_the_instructions() {
    let h = harness_with(MEETING_SAMPLE_RATE, |o| {
        o.tools.catalog = Some("# Tool Catalog\n- gh__create_issue".into())
    })
    .await;
    assert_eq!(
        h.of_type("session.update")[0]["session"]["instructions"],
        "You are Emma.\n\n# Tool Catalog\n- gh__create_issue"
    );
    h.conversation.stop();
}

#[tokio::test]
async fn reports_a_close_the_server_initiated() {
    let h = harness().await;
    h.server.drop_from_server();
    settle().await;
    settle().await;
    let lost = h.lost.lock().clone();
    assert_eq!(lost.len(), 1);
    assert!(lost[0].contains("server gone"));
}

#[tokio::test]
async fn says_nothing_about_a_close_it_asked_for_itself() {
    let h = harness().await;
    h.conversation.stop();
    settle().await;
    settle().await;
    assert!(h.lost.lock().is_empty());
}

#[tokio::test]
async fn reports_a_close_only_once() {
    let h = harness().await;
    h.server.drop_from_server();
    settle().await;
    h.conversation.stop();
    settle().await;
    assert_eq!(h.lost.lock().len(), 1);
}

#[tokio::test]
async fn hints_the_transcriber_when_the_log_will_carry_the_words() {
    transcript_log::set_full_for_test(Some(true));
    let h = harness().await;
    let names: Vec<String> = ["Emma", "Mario Sarcher", "Lee"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    h.conversation.set_participant_names(&names);
    settle().await;
    let update = h.of_type("session.update").pop().unwrap();
    let keywords = update["session"]["audio"]["input"]["transcription"]["keywords"].clone();
    // The agent's own name leads.
    assert_eq!(keywords, json!(["Emma", "Lee", "Mario Sarcher"]));

    // Re-sending an unchanged roster would mutate a live session every poll.
    let before = h.sent().len();
    h.conversation.set_participant_names(&names);
    settle().await;
    assert_eq!(h.sent().len(), before);
    transcript_log::set_full_for_test(None);
    h.conversation.stop();
}

#[tokio::test]
async fn sends_no_transcriber_config_at_all_when_nothing_will_read_it() {
    transcript_log::set_full_for_test(Some(false));
    let h = harness().await;
    h.conversation
        .set_participant_names(&["Emma".into(), "Mario Sarcher".into()]);
    settle().await;
    assert!(
        !serde_json::to_string(&h.of_type("session.update"))
            .unwrap()
            .contains("transcription")
    );
    transcript_log::set_full_for_test(None);
    h.conversation.stop();
}

#[tokio::test]
async fn tells_the_model_who_is_in_the_room_either_way() {
    let h = harness().await;
    h.conversation
        .set_participant_names(&["Emma".into(), "Mario Sarcher".into(), "Lee".into()]);
    settle().await;
    let context = h.of_type("conversation.item.create");
    assert_eq!(
        context[0]["item"]["content"][0]["text"],
        "The people in the call with you are now: Lee, Mario Sarcher. The audio is still one mixed channel, so you cannot hear which of them is speaking — call `meeting_speaker` when you need to know who you are answering or who just spoke. Never guess at a name."
    );
    assert_eq!(h.conversation.roster(), vec!["Lee", "Mario Sarcher"]);
    h.conversation.stop();
}

#[tokio::test]
async fn ignores_a_reordering_of_the_same_people() {
    let h = harness().await;
    h.conversation
        .set_participant_names(&["Emma".into(), "Mario Sarcher".into(), "Lee".into()]);
    settle().await;
    let before = h.sent().len();
    h.conversation
        .set_participant_names(&["Lee".into(), "Emma".into(), "Mario Sarcher".into()]);
    settle().await;
    assert_eq!(h.sent().len(), before);
    h.conversation.stop();
}

#[tokio::test]
async fn does_not_tell_the_model_it_is_alone_when_the_scrape_found_only_itself() {
    let h = harness().await;
    h.conversation.set_participant_names(&["Emma".into()]);
    settle().await;
    assert!(h.of_type("conversation.item.create").is_empty());
    h.conversation.stop();
}

#[tokio::test]
async fn asks_about_the_utterance_that_just_closed_and_answers_when_told_to() {
    let h = harness().await;
    h.commit("item-1");
    settle().await;
    let probe = h.probes().pop().unwrap();
    assert_eq!(probe["response"]["conversation"], "none");
    let referenced: Vec<String> = probe["response"]["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(referenced.last().map(String::as_str), Some("item-1"));
    assert!(referenced.len() <= 12);
    assert!(h.spoken_requests().is_empty());

    h.answer_gate("YES").await;
    assert_eq!(h.spoken_requests().len(), 1);
    h.conversation.stop();
}

#[tokio::test]
async fn stays_quiet_when_the_utterance_was_not_for_the_agent() {
    let h = harness().await;
    h.commit("item-2");
    settle().await;
    h.answer_gate("NO").await;
    assert!(h.spoken_requests().is_empty());
    let stats = h.conversation.statistics();
    assert_eq!((stats.gate_calls, stats.gate_failed), (1, 0));
    h.conversation.stop();
}

#[tokio::test]
async fn answers_an_utterance_once_even_if_the_turn_closes_twice() {
    let h = harness().await;
    h.commit("item-3");
    settle().await;
    h.answer_gate("YES").await;
    let probes = h.probes().len();
    h.commit("item-3");
    settle().await;
    assert_eq!(h.spoken_requests().len(), 1);
    assert_eq!(h.probes().len(), probes);
    h.conversation.stop();
}

#[tokio::test]
async fn drops_a_verdict_once_a_later_utterance_has_closed() {
    let h = harness().await;
    h.commit("item-first");
    settle().await;
    let first = h.probes()[0].clone();
    h.commit("item-second");
    settle().await;
    // Answer the first probe only.
    h.server.emit(json!({ "type": "response.created", "response": { "id": "r-1", "metadata": first["response"]["metadata"] } }));
    h.server.emit(json!({ "type": "response.done", "response": { "id": "r-1", "status": "completed", "output": [{ "content": [{ "text": "YES" }] }] } }));
    settle().await;
    settle().await;
    assert!(h.spoken_requests().is_empty());
    assert_eq!(h.conversation.statistics().gate_superseded, 1);
    h.conversation.stop();
}

#[tokio::test]
async fn does_not_let_a_duplicated_commit_rewind_the_supersession_guard() {
    let h = harness().await;
    h.commit("item-a");
    settle().await;
    let first = h.probes()[0].clone();
    h.commit("item-b");
    settle().await;
    h.commit("item-a");
    settle().await;
    h.server.emit(json!({ "type": "response.created", "response": { "id": "r-a", "metadata": first["response"]["metadata"] } }));
    h.server.emit(json!({ "type": "response.done", "response": { "id": "r-a", "status": "completed", "output": [{ "content": [{ "text": "YES" }] }] } }));
    settle().await;
    settle().await;
    assert!(h.spoken_requests().is_empty());
    assert_eq!(h.conversation.statistics().gate_superseded, 1);
    h.conversation.stop();
}

#[tokio::test]
async fn counts_a_verdict_that_never_came_so_a_deaf_agent_is_visible() {
    let h = harness().await;
    h.commit("item-4");
    settle().await;
    h.server.drop_from_server();
    settle().await;
    settle().await;
    assert!(h.spoken_requests().is_empty());
    let stats = h.conversation.statistics();
    assert_eq!((stats.gate_calls, stats.gate_failed), (1, 1));
}

#[tokio::test]
async fn reports_the_human_the_platform_named() {
    let h = harness().await;
    h.conversation
        .set_current_speaker(Some(reading("Mario Sarcher")));
    assert_eq!(
        h.conversation.current_speaker().map(|r| r.who),
        Some(SpeakerDetails::Person {
            name: "Mario Sarcher".into()
        })
    );
    h.conversation.stop();
}

#[tokio::test]
async fn reports_nobody_while_the_agent_itself_is_the_one_being_captioned() {
    let h = harness().await;
    h.conversation
        .set_current_speaker(Some(reading("Mario Sarcher")));
    h.conversation.set_current_speaker(Some(SpeakerReading {
        id: "devices/9".into(),
        is_self: true,
        who: SpeakerDetails::Person {
            name: "Iris".into(),
        },
    }));
    assert_eq!(h.conversation.current_speaker(), None);
    h.conversation.stop();
}

#[tokio::test]
async fn keeps_the_last_speaker_when_a_read_comes_back_empty() {
    let h = harness().await;
    h.conversation
        .set_current_speaker(Some(reading("Emma Lee")));
    h.conversation.set_current_speaker(None);
    assert!(h.conversation.current_speaker().is_some());
    h.conversation.stop();
}

#[tokio::test]
async fn counts_how_often_a_closed_utterance_had_a_speaker_attached() {
    let h = harness().await;
    h.conversation
        .set_current_speaker(Some(reading("Emma Lee")));
    h.commit("item-40");
    settle().await;
    settle().await;
    let stats = h.conversation.statistics();
    assert_eq!(
        (stats.attributed_utterances, stats.unattributed_utterances),
        (1, 0)
    );
    h.conversation.stop();
}

#[tokio::test]
async fn counts_an_unattributed_utterance_when_the_platform_said_nothing() {
    let h = harness().await;
    h.commit("item-41");
    settle().await;
    settle().await;
    let stats = h.conversation.statistics();
    assert_eq!(
        (stats.attributed_utterances, stats.unattributed_utterances),
        (0, 1)
    );
    h.conversation.stop();
}

fn appended_lengths(h: &Harness) -> Vec<usize> {
    h.of_type("input_audio_buffer.append")
        .iter()
        .map(|f| {
            crate::services::meeting::realtime_session::decode_base64_lenient(
                f["audio"].as_str().unwrap(),
            )
            .len()
        })
        .collect()
}

#[tokio::test]
async fn halves_the_rate_of_what_the_caller_pushes() {
    let h = harness().await;
    h.conversation.push_audio(&[0u8; 960]);
    eventually("the appended audio", || !appended_lengths(&h).is_empty()).await;
    assert_eq!(appended_lengths(&h), vec![480]);
    h.conversation.stop();
}

#[tokio::test]
async fn sends_what_the_caller_pushes_untouched_when_the_transport_speaks_24khz() {
    let h = harness_with(REALTIME_SAMPLE_RATE, |_| {}).await;
    h.conversation.push_audio(&[0u8; 480]);
    eventually("the appended audio", || !appended_lengths(&h).is_empty()).await;
    assert_eq!(appended_lengths(&h), vec![480]);
    h.conversation.stop();
}

#[tokio::test]
async fn refuses_a_rate_it_has_no_converter_for() {
    let server = MockServer::start().await;
    let mut options = options(&server, 16_000);
    options.endpoint_override = Some(RealtimeEndpoint {
        url: "ws://127.0.0.1:1".into(),
        ..Default::default()
    });
    let err = VoiceConversation::new(options).err().unwrap();
    assert!(err.to_string().contains("16000"));
}

#[tokio::test]
async fn sends_nothing_after_the_conversation_stops() {
    let h = harness().await;
    h.conversation.stop();
    settle().await;
    h.conversation.push_audio(&[0u8; 960]);
    settle().await;
    assert!(appended_lengths(&h).is_empty());
}

#[tokio::test]
async fn declares_what_a_load_tools_call_loaded_before_it_sends_the_calls_output() {
    let declaration = |name: &str| RealtimeFunctionTool {
        name: name.into(),
        description: name.into(),
        parameters: json!({}),
    };
    let current = Arc::new(Mutex::new(Arc::new(vec![declaration("load_tools")])));
    let read = current.clone();
    let write = current.clone();
    let tools = PreparedTools {
        declarations: Arc::new(move || read.lock().clone()),
        count: 2,
        catalog: Some("# Tool Catalog\n- gh__create_issue".into()),
        execute: Arc::new(move |_name: String, _args: String| {
            *write.lock() = Arc::new(vec![
                declaration("gh__create_issue"),
                declaration("load_tools"),
            ]);
            async { "Loaded gh__create_issue.".to_string() }.boxed()
        }),
    };
    let h = harness_with(MEETING_SAMPLE_RATE, |o| o.tools = tools).await;
    h.server.emit(json!({
        "type": "response.function_call_arguments.done",
        "call_id": "call-1",
        "name": "load_tools",
        "arguments": "{\"names\":[\"gh__create_issue\"]}",
    }));
    eventually("the call's output", || {
        h.sent().iter().any(|f| {
            f["type"] == "conversation.item.create" && f["item"]["type"] == "function_call_output"
        })
    })
    .await;
    let sent = h.sent();
    let update = sent
        .iter()
        .position(|f| {
            f["type"] == "session.update"
                && f["session"]["tools"].as_array().map(Vec::len) == Some(2)
        })
        .expect("the loaded tool was declared");
    let output = sent
        .iter()
        .position(|f| {
            f["type"] == "conversation.item.create" && f["item"]["type"] == "function_call_output"
        })
        .expect("the output was sent");
    assert!(output > update);
    let names: Vec<&str> = sent[update]["session"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["gh__create_issue", "load_tools"]);
    h.conversation.stop();
}

#[tokio::test]
async fn asks_the_whole_call_then_closes_without_reporting_a_lost_session() {
    let h = harness_with(MEETING_SAMPLE_RATE, |o| {
        o.response_mode = ResponseMode::Open
    })
    .await;
    let conversation = h.conversation.clone();
    let answer = tokio::spawn(async move {
        conversation
            .stop_with_text(StopWithTextRequest {
                instructions: "Summarize the call.".into(),
                deadline_ms: 1_000,
                ..Default::default()
            })
            .await
    });
    settle().await;
    let request = h.probes().pop().unwrap();
    assert_eq!(request["response"]["instructions"], "Summarize the call.");
    // No input, so the model reads every item of the call.
    assert!(request["response"].get("input").is_none());
    h.server.emit(json!({
        "type": "response.done",
        "response": { "id": "r-summary", "status": "completed", "metadata": request["response"]["metadata"], "output": [{ "content": [{ "text": "You asked about the deploy." }] }] },
    }));
    assert_eq!(
        answer.await.unwrap().as_deref(),
        Some("You asked about the deploy.")
    );
    settle().await;
    assert!(h.lost.lock().is_empty());
    let again = h
        .conversation
        .stop_with_text(StopWithTextRequest {
            instructions: "again".into(),
            deadline_ms: 100,
            ..Default::default()
        })
        .await;
    assert_eq!(again, None);
}

#[tokio::test]
async fn answers_no_utterance_that_closes_while_it_writes() {
    let h = harness_with(MEETING_SAMPLE_RATE, |o| {
        o.response_mode = ResponseMode::Open
    })
    .await;
    let conversation = h.conversation.clone();
    tokio::spawn(async move {
        conversation
            .stop_with_text(StopWithTextRequest {
                instructions: "Summarize the call.".into(),
                deadline_ms: 1_000,
                ..Default::default()
            })
            .await
    });
    tokio::time::sleep(Duration::from_millis(5)).await;
    h.commit("item-late");
    settle().await;
    assert!(h.spoken_requests().is_empty());
}
