use super::*;
use crate::lib::model_selection::{ModelSelection, ModelSelectionMode, ModelTiers};
use crate::prompts::context_builder::ConversationMessage;
use serde_json::json;

fn row(id: &str, role: &str, content: &str) -> Value {
    json!({ "id": id, "role": role, "content": content, "externalMessageId": null, "internalStep": false })
}

fn context(rows: Vec<Value>) -> AgentContext {
    let recent_messages: Vec<ConversationMessage> =
        serde_json::from_value(Value::Array(rows)).expect("rows");
    AgentContext {
        soul_md: String::new(),
        user_md: String::new(),
        memory_md: String::new(),
        heartbeat_md: String::new(),
        bootstrap_md: String::new(),
        vision_md: String::new(),
        agent_md: String::new(),
        agent_name: "TestAgent".into(),
        agent_id: "agent-1".into(),
        user_id: "user-1".into(),
        model: None,
        heartbeat_model: None,
        cron_model: None,
        model_selection: ModelSelection {
            mode: ModelSelectionMode::Fixed,
            tiers: ModelTiers::default(),
        },
        verbose: false,
        locked_in: false,
        is_bootstrap_phase: false,
        conversation_summary: None,
        compacted_history_readable: false,
        recent_messages,
        posting_ceiling: None,
        last_send: None,
        runtime_notices: None,
    }
}

fn texts(messages: &[ModelMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| serde_json::to_value(message).unwrap())
        .collect()
}

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|id| id.to_string()).collect()
}

#[test]
fn a_follow_up_restates_the_newer_message_after_the_appended_prompt() {
    // m1 was left over from the previous turn; m2 was handed to the follow-up
    // before its history read, so the follow-up answers it from history.
    let context = context(vec![
        row("m1", "USER", "run tests"),
        row("r1", "AGENT", "Done."),
        row("m2", "USER", "skip tests"),
    ]);
    let restated = restated_after_follow_up(&context, &ids(&["m1"]), false);
    assert_eq!(
        texts(&restated),
        [json!({ "role": "user", "content": "skip tests" })]
    );
}

#[test]
fn a_follow_up_restates_no_row_of_the_appended_prompt_itself() {
    // m1 was stored after the reply, so its row already follows it.
    let context = context(vec![
        row("r1", "AGENT", "Done."),
        row("m1", "USER", "run tests"),
    ]);
    assert!(restated_after_follow_up(&context, &ids(&["m1"]), false).is_empty());
}

#[test]
fn a_follow_up_restates_nothing_when_history_gives_the_rows_ids_of_its_own() {
    // A thread provider that reads history live gives each row an id of its own.
    let context = context(vec![
        row("live-r1", "AGENT", "Done."),
        row("live-m1", "USER", "run tests"),
    ]);
    assert!(restated_after_follow_up(&context, &ids(&["m1"]), false).is_empty());
}

/// A message sent after Stop is stored before the stopped turn stores its last
/// reply, and history is ordered by row, so it ends on that reply.
fn stopped_rows(last_agent: bool) -> AgentContext {
    let mut rows = vec![
        row("first", "USER", "review the PR"),
        row("second", "USER", "summarize the README"),
    ];
    if last_agent {
        rows.push(row("reply", "AGENT", "Stopped."));
    }
    context(rows)
}

#[test]
fn restates_the_prompt_when_the_history_ends_on_an_agent_row_after_its_row() {
    let restated = restated_after_reply(&stopped_rows(true), Some("second"), false);
    assert_eq!(
        texts(&restated),
        [json!({ "role": "user", "content": "summarize the README" })]
    );
}

#[test]
fn restates_every_user_row_from_the_prompt_on_in_order() {
    let restated = restated_after_reply(&stopped_rows(true), Some("first"), false);
    assert_eq!(
        texts(&restated),
        [
            json!({ "role": "user", "content": "review the PR" }),
            json!({ "role": "user", "content": "summarize the README" }),
        ]
    );
}

#[test]
fn restates_a_file_only_prompt_with_its_attachment_stub() {
    let mut file_row = row("file", "USER", "");
    file_row["attachments"] = json!([{
        "id": "att-1",
        "filename": "screen.png",
        "mediaType": "image/png",
        "category": "image",
        "sizeBytes": 2048,
        "expired": false,
    }]);
    let context = context(vec![file_row, row("reply", "AGENT", "Stopped.")]);
    let restated = restated_after_reply(&context, Some("file"), false);
    let last = serde_json::to_value(restated.last().unwrap()).unwrap();
    assert_eq!(last["role"], "user");
    assert!(
        last["content"]
            .as_str()
            .unwrap()
            .contains("[Attachment: screen.png · id=att-1")
    );
}

#[test]
fn restates_nothing_when_the_history_ends_on_the_prompt_row() {
    assert!(restated_after_reply(&stopped_rows(false), Some("second"), false).is_empty());
}

#[test]
fn restates_nothing_when_the_history_does_not_hold_the_prompt_row() {
    assert!(restated_after_reply(&stopped_rows(true), Some("slack-ts"), false).is_empty());
    assert!(restated_after_reply(&stopped_rows(true), None, false).is_empty());
}

fn guard_context() -> TrailingAssistantContext {
    TrailingAssistantContext {
        agent_id: "agent-1".into(),
        user_id: "user-1".into(),
        mode: "chat".into(),
        stage: InvokeStage::Step,
        guard: Arc::new(AtomicBool::new(false)),
    }
}

#[test]
fn reports_an_array_that_ends_on_an_assistant_turn() {
    let context = guard_context();
    warn_on_trailing_assistant(
        &[ModelMessage::user("hi"), ModelMessage::assistant("hello")],
        &context,
    );
    assert!(context.guard.load(Ordering::SeqCst));
}

#[test]
fn stays_quiet_on_a_user_or_tool_tail() {
    let context = guard_context();
    warn_on_trailing_assistant(&[ModelMessage::user("hi")], &context);
    warn_on_trailing_assistant(
        &[ModelMessage::user("hi"), ModelMessage::tool(vec![])],
        &context,
    );
    warn_on_trailing_assistant(&[], &context);
    assert!(!context.guard.load(Ordering::SeqCst));
}

#[test]
fn names_the_stages_as_the_telemetry_does() {
    assert_eq!(InvokeStage::Initial.as_str(), "initial");
    assert_eq!(InvokeStage::Step.as_str(), "step");
    assert_eq!(InvokeStage::EarlyStopping.as_str(), "early-stopping");
}

#[test]
fn collects_the_ids_of_successful_shares_only() {
    let ok = json!({ "success": true, "attachmentId": "a-1" });
    let failed = json!({ "success": false, "attachmentId": "a-2" });
    let other = json!({ "attachmentId": "a-3" });
    let ids = extract_attachment_ids(
        [
            ("share_file", "c1"),
            ("share_file", "c2"),
            ("shell_exec", "c3"),
        ],
        [("c1", &ok), ("c2", &failed), ("c3", &other)],
    );
    assert_eq!(ids, ["a-1"]);
}

#[test]
fn reads_an_attachment_id_through_a_cut_envelope() {
    let wrapped = json!({
        "__prismToolOutputSpill": true,
        "text": "cut",
        "truncation": { "totalChars": 10, "keptChars": 5, "omittedChars": 5 },
        "raw": { "success": true, "attachmentId": "a-9" },
    });
    let ids = extract_attachment_ids([("share_file", "c1")], [("c1", &wrapped)]);
    assert_eq!(ids, ["a-9"]);
}

#[test]
fn finds_no_attachment_without_a_share() {
    let ids = extract_attachment_ids(std::iter::empty(), std::iter::empty());
    assert!(ids.is_empty());
}

#[test]
fn joins_only_the_steps_that_have_text() {
    let steps = vec![
        InvokeStep {
            text: "one".into(),
            ..Default::default()
        },
        InvokeStep::default(),
        InvokeStep {
            text: "two".into(),
            ..Default::default()
        },
    ];
    assert_eq!(join_step_texts(&steps), "one\n\ntwo");
}

#[tokio::test]
async fn a_generator_runs_only_while_its_consumer_asks() {
    let progress = Arc::new(AtomicUsize::new(0));
    let seen = progress.clone();
    let mut stream = generate(move |y: Yielder<i32>| async move {
        seen.fetch_add(1, Ordering::SeqCst);
        y.yield_(1).await;
        seen.fetch_add(1, Ordering::SeqCst);
        y.yield_(2).await;
        seen.fetch_add(1, Ordering::SeqCst);
    });
    assert_eq!(progress.load(Ordering::SeqCst), 0);
    assert_eq!(stream.next().await, Some(1));
    assert_eq!(progress.load(Ordering::SeqCst), 1);
    assert_eq!(stream.next().await, Some(2));
    assert_eq!(progress.load(Ordering::SeqCst), 2);
    assert_eq!(stream.next().await, None);
    assert_eq!(progress.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn dropping_a_generator_stops_its_producer() {
    let progress = Arc::new(AtomicUsize::new(0));
    let seen = progress.clone();
    let mut stream = generate(move |y: Yielder<i32>| async move {
        y.yield_(1).await;
        seen.fetch_add(1, Ordering::SeqCst);
    });
    assert_eq!(stream.next().await, Some(1));
    drop(stream);
    assert_eq!(progress.load(Ordering::SeqCst), 0);
}

#[test]
fn records_every_mode_under_its_own_purpose() {
    assert_eq!(purpose_for(InvokeMode::Chat), LlmCallPurpose::Chat);
    assert_eq!(
        purpose_for(InvokeMode::Heartbeat),
        LlmCallPurpose::Heartbeat
    );
    assert_eq!(purpose_for(InvokeMode::Cron), LlmCallPurpose::Cron);
    assert_eq!(purpose_for(InvokeMode::Subagent), LlmCallPurpose::Subagent);
    assert_eq!(purpose_for(InvokeMode::Goal), LlmCallPurpose::Goal);
    assert_eq!(purpose_for(InvokeMode::Webhook), LlmCallPurpose::Webhook);
}

#[test]
fn gives_each_run_a_request_of_its_own_on_its_thread() {
    let request = InvokeRequest {
        mode: InvokeMode::Heartbeat,
        thread_id: Some("thread-1".into()),
        ..InvokeRequest::default()
    };
    let first = spend_context_for(&request);
    let second = spend_context_for(&request);
    assert_eq!(first.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(
        first.source,
        Some(SpendSource::of(SpendSourceKind::Heartbeat))
    );
    assert!(!first.request_id.is_empty());
    assert_ne!(second.request_id, first.request_id);
}

#[tokio::test]
async fn keeps_the_request_a_caller_names_and_not_the_request_of_the_turn_it_was_started_from() {
    let parent = SpendContext {
        request_id: "message-1".into(),
        thread_id: Some("thread-1".into()),
        source: None,
    };
    let request = InvokeRequest {
        mode: InvokeMode::Goal,
        thread_id: Some("thread-2".into()),
        request_id: Some("goal-1".into()),
        source_id: Some("goal-1".into()),
        ..InvokeRequest::default()
    };
    let spend = with_spend_context(parent, async { spend_context_for(&request) }).await;
    assert_eq!(
        spend,
        SpendContext {
            request_id: "goal-1".into(),
            thread_id: Some("thread-2".into()),
            source: Some(SpendSource {
                kind: SpendSourceKind::Goal,
                id: Some("goal-1".into()),
            }),
        }
    );
}

#[tokio::test]
async fn spends_a_subagents_run_on_its_parents_request() {
    let parent = SpendContext {
        request_id: "message-1".into(),
        thread_id: Some("thread-1".into()),
        source: None,
    };
    let request = InvokeRequest {
        mode: InvokeMode::Subagent,
        ..InvokeRequest::default()
    };
    let spend = with_spend_context(parent.clone(), async { spend_context_for(&request) }).await;
    assert_eq!(spend, parent);
}
