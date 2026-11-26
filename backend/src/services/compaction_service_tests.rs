use std::collections::VecDeque;
use std::time::Duration;

use async_trait::async_trait;
use diesel::prelude::*;
use serde_json::{Value, json};

use super::*;
use crate::ai::{
    FinishReason, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4FinishReason,
    LanguageModelV4GenerateResult, LanguageModelV4InputTokens, LanguageModelV4OutputTokens,
    LanguageModelV4Usage, Tool,
};
use crate::db::models::{
    MessageRole, MessageTrigger, NewAgentWorkspace, NewConversationMessage, NewConversationThread,
};
use crate::db::schema::{agent_workspaces, conversation_messages, conversation_threads};
use crate::db::testing::{TestDb, test_db};
use crate::lib::llm_providers::llm_provider::ANTHROPIC_CACHE_POINT;

/// A model that answers from a script and records what it was sent.
struct Scripted {
    responses: Mutex<VecDeque<anyhow::Result<LanguageModelV4GenerateResult>>>,
    calls: Mutex<Vec<LanguageModelV4CallOptions>>,
}

impl Scripted {
    fn new(responses: Vec<anyhow::Result<LanguageModelV4GenerateResult>>) -> Arc<Self> {
        Arc::new(Self {
            responses: Mutex::new(responses.into()),
            calls: Mutex::new(Vec::new()),
        })
    }

    fn answering(text: &str) -> Arc<Self> {
        Self::new(vec![Ok(answer(text, FinishReason::Stop))])
    }

    fn call(&self, i: usize) -> LanguageModelV4CallOptions {
        self.calls.lock()[i].clone()
    }

    fn call_count(&self) -> usize {
        self.calls.lock().len()
    }
}

#[async_trait]
impl LanguageModel for Scripted {
    fn provider(&self) -> &str {
        "mock-provider"
    }

    fn model_id(&self) -> &str {
        "model-x"
    }

    async fn do_generate(
        &self,
        options: LanguageModelV4CallOptions,
    ) -> anyhow::Result<LanguageModelV4GenerateResult> {
        self.calls.lock().push(options);
        self.responses
            .lock()
            .pop_front()
            .unwrap_or_else(|| Ok(answer("fallback", FinishReason::Stop)))
    }
}

fn answer(text: &str, finish: FinishReason) -> LanguageModelV4GenerateResult {
    LanguageModelV4GenerateResult {
        content: vec![LanguageModelV4Content::Text {
            text: text.into(),
            provider_metadata: None,
        }],
        finish_reason: LanguageModelV4FinishReason {
            unified: finish,
            raw: None,
        },
        usage: LanguageModelV4Usage {
            input_tokens: LanguageModelV4InputTokens {
                total: Some(3),
                no_cache: Some(3),
                ..Default::default()
            },
            output_tokens: LanguageModelV4OutputTokens {
                total: Some(4),
                text: Some(4),
                ..Default::default()
            },
            raw: None,
        },
        provider_metadata: None,
        request: None,
        response: None,
        warnings: vec![],
    }
}

fn rows(count: usize) -> Vec<ForkRow> {
    (0..count)
        .map(|i| ForkRow {
            id: format!("m{i}"),
            external_message_id: None,
            internal_step: false,
            // Rows alternate request and reply, so the tail can start on any even index.
            from_user: i % 2 == 0,
            content_chars: 100,
        })
        .collect()
}

fn row(id: &str, from_user: bool, content_chars: i64) -> ForkRow {
    ForkRow {
        id: id.into(),
        external_message_id: None,
        internal_step: false,
        from_user,
        content_chars,
    }
}

fn tail_ids(split: &TailSplit) -> Vec<&str> {
    split.tail.iter().map(|row| row.id.as_str()).collect()
}

/// A model with a 1M window, so the estimate after a compaction has a percentage.
const MODEL: &str = "us.anthropic.claude-opus-5";

fn fork(thread_id: &str, model: Arc<Scripted>) -> AutoCompactFork {
    let mut tools = ToolSet::new();
    tools.insert(
        "shell".into(),
        Tool {
            description: Some("sh".into()),
            ..Default::default()
        },
    );
    AutoCompactFork {
        fork: CompactionFork {
            user_id: "user-1".into(),
            agent_id: "agent-1".into(),
            thread_id: thread_id.into(),
            model_id: MODEL.into(),
            model,
            cache_point: ANTHROPIC_CACHE_POINT,
            cache_request: crate::lib::llm_providers::llm_provider::provider_options(json!({})),
            system: vec![SystemModelMessage::new("system prompt")],
            tools,
            declared_tools: false,
            messages: vec![
                ModelMessage::user("first"),
                ModelMessage::assistant("reply"),
                ModelMessage::user("latest"),
            ],
            injections: Vec::new(),
            context_rows: rows(8),
        },
        final_assistant_text: "final answer".into(),
        snapshot: ContextUsageSnapshot {
            thread_id: thread_id.into(),
            model_id: MODEL.into(),
            used_tokens: 190_000,
            window_tokens: 200_000,
            used_percent: 95,
        },
    }
}

/// The agent the runtime runs as, a thread of `source`, and one stored message per
/// fork row, a second apart.
fn seed(test: &TestDb, thread_id: &str, source: ThreadSource, row_ids: &[&str]) {
    let thread_id = thread_id.to_string();
    let row_ids: Vec<String> = row_ids.iter().map(|id| id.to_string()).collect();
    test.db
        .run_sync(move |conn| {
            let mut agent = NewAgentWorkspace::new("user-1", "soul", "user", "memory", "hb", "");
            agent.id = "test-agent-id".into();
            diesel::insert_into(agent_workspaces::table)
                .values(&agent)
                .execute(conn)?;
            let mut thread = NewConversationThread::new("test-agent-id", "user-1");
            thread.id = thread_id.clone();
            thread.thread_source = source;
            thread.context_tokens = Some(12_345);
            diesel::insert_into(conversation_threads::table)
                .values(&thread)
                .execute(conn)?;
            let start = Utc::now() - chrono::Duration::hours(1);
            for (i, id) in row_ids.iter().enumerate() {
                let mut message = NewConversationMessage::new(
                    thread_id.clone(),
                    MessageRole::User,
                    "text",
                    MessageTrigger::UserInput,
                );
                message.id = id.clone();
                message.created_at = (start + chrono::Duration::seconds(i as i64)).into();
                diesel::insert_into(conversation_messages::table)
                    .values(&message)
                    .execute(conn)?;
            }
            Ok(())
        })
        .unwrap();
}

fn compacted_ids(test: &TestDb, thread_id: &str) -> Vec<String> {
    let thread_id = thread_id.to_string();
    test.db
        .run_sync(move |conn| {
            Ok(conversation_messages::table
                .filter(conversation_messages::thread_id.eq(thread_id))
                .filter(conversation_messages::is_compacted.eq(true))
                .order(conversation_messages::created_at.asc())
                .select(conversation_messages::id)
                .load::<String>(conn)?)
        })
        .unwrap()
}

fn stored_thread(test: &TestDb, thread_id: &str) -> (Option<String>, Option<String>, bool) {
    let thread_id = thread_id.to_string();
    test.db
        .run_sync(move |conn| {
            let (summary, through, at) = conversation_threads::table
                .filter(conversation_threads::id.eq(thread_id))
                .select((
                    conversation_threads::compaction_summary,
                    conversation_threads::compacted_through_ts,
                    conversation_threads::compacted_at,
                ))
                .first::<(Option<String>, Option<String>, Option<DateTime<Utc>>)>(conn)?;
            Ok((summary, through, at.is_some()))
        })
        .unwrap()
}

/// Every compaction event of `thread_id` from now on.
fn capture(thread_id: &str) -> Arc<Mutex<Vec<CompactionEvent>>> {
    let seen: Arc<Mutex<Vec<CompactionEvent>>> = Arc::default();
    let sink = Arc::clone(&seen);
    let thread_id = thread_id.to_string();
    COMPACTION_SERVICE.events.on_compaction(move |event| {
        if event.thread_id == thread_id {
            sink.lock().push(event.clone());
        }
    });
    seen
}

/// Waits for the thread's queued compaction to settle.
async fn settled(thread_id: &str) {
    for _ in 0..500 {
        if !COMPACTION_SERVICE.in_flight.lock().contains(thread_id) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the compaction of {thread_id} did not settle");
}

fn statuses(events: &Arc<Mutex<Vec<CompactionEvent>>>) -> Vec<CompactionStatus> {
    events.lock().iter().map(|event| event.status).collect()
}

fn prompt_json(call: &LanguageModelV4CallOptions) -> Value {
    serde_json::to_value(&call.prompt).unwrap()
}

// ---------------------------------------------------------------------------
// maybe_auto_compact guards
// ---------------------------------------------------------------------------

#[tokio::test]
async fn does_nothing_below_the_threshold() {
    let mut below = fork("guard-below", Scripted::answering("S"));
    below.snapshot.used_percent = 89;
    COMPACTION_SERVICE.maybe_auto_compact(below);
    assert!(!COMPACTION_SERVICE.in_flight.lock().contains("guard-below"));
}

#[tokio::test]
async fn refuses_an_implausibly_small_window() {
    let mut small = fork("guard-window", Scripted::answering("S"));
    small.snapshot.window_tokens = 999;
    COMPACTION_SERVICE.maybe_auto_compact(small);
    assert!(!COMPACTION_SERVICE.in_flight.lock().contains("guard-window"));
}

#[tokio::test]
async fn does_nothing_when_the_context_has_no_more_rows_than_the_tail() {
    let mut short = fork("guard-tail", Scripted::answering("S"));
    short.fork.context_rows = rows(6);
    COMPACTION_SERVICE.maybe_auto_compact(short);
    assert!(!COMPACTION_SERVICE.in_flight.lock().contains("guard-tail"));
}

#[tokio::test]
async fn does_nothing_when_overflow_recovery_has_nothing_to_compact() {
    let mut short = fork("guard-overflow", Scripted::answering("S")).fork;
    short.context_rows = rows(6);
    COMPACTION_SERVICE.maybe_compact_after_overflow(short);
    assert!(
        !COMPACTION_SERVICE
            .in_flight
            .lock()
            .contains("guard-overflow")
    );
}

// ---------------------------------------------------------------------------
// the forked summarize request, commit and finish
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial_test::serial]
async fn compacts_a_database_thread_at_the_threshold_from_the_turns_own_request() {
    let test = test_db();
    let ids = ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"];
    seed(&test, "auto-db", ThreadSource::Database, &ids);
    let model = Scripted::answering("THE SUMMARY");
    let events = capture("auto-db");
    let mut at_threshold = fork("auto-db", Arc::clone(&model));
    at_threshold.snapshot.used_percent = 90;
    at_threshold.fork.injections = vec![ModelMessage::user("mid-turn steer")];

    COMPACTION_SERVICE.maybe_auto_compact(at_threshold.clone());
    // A second request while the first is queued is collapsed into it.
    COMPACTION_SERVICE.maybe_auto_compact(at_threshold);
    settled("auto-db").await;

    assert_eq!(model.call_count(), 1);
    let call = model.call(0);
    let prompt = prompt_json(&call);
    let roles: Vec<&str> = prompt
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["role"].as_str().unwrap())
        .collect();
    assert_eq!(
        roles,
        [
            "system",
            "user",
            "assistant",
            "user",
            "user",
            "assistant",
            "user"
        ]
    );
    assert_eq!(prompt[4]["content"][0]["text"], json!("mid-turn steer"));
    assert_eq!(prompt[5]["content"][0]["text"], json!("final answer"));
    assert_eq!(prompt[6]["content"][0]["text"], json!(COMPACTION_PROMPT));
    // The final-message breakpoint is what cache-reads the turn's history.
    assert_eq!(
        prompt[6]["providerOptions"],
        json!({ "anthropic": { "cacheControl": { "type": "ephemeral" } } })
    );
    assert_eq!(
        serde_json::to_value(&call.tool_choice).unwrap(),
        json!({ "type": "none" })
    );
    // 200,000 - 190,000 - 4,000 leaves 6,000 tokens of room.
    assert_eq!(call.max_output_tokens, Some(6_000));

    // 8 fork rows, tail 6: the oldest 2 are compacted.
    assert_eq!(compacted_ids(&test, "auto-db"), ["m0", "m1"]);
    let (summary, through, compacted) = stored_thread(&test, "auto-db");
    assert_eq!(summary.as_deref(), Some("THE SUMMARY"));
    assert!(compacted);
    assert!(through.unwrap().ends_with('Z'));

    // 'THE SUMMARY' is 11 chars and the tail 6 rows of 100.
    let expected = (11 + 600 + 3) / 4;
    let last = events.lock().last().cloned().unwrap();
    assert_eq!(
        statuses(&events),
        [CompactionStatus::Started, CompactionStatus::Completed]
    );
    assert_eq!(last.trigger, CompactionTrigger::Auto);
    assert_eq!(last.messages_compacted, Some(2));
    assert_eq!(last.tokens_before, Some(Some(190_000)));
    assert_eq!(last.tokens_after, Some(Some(expected)));
    assert_eq!(
        serde_json::to_value(&last).unwrap(),
        json!({
            "userId": "user-1",
            "threadId": "auto-db",
            "status": "completed",
            "trigger": "auto",
            "tokensBefore": 190000,
            "tokensAfter": expected,
            "messagesCompacted": 2,
        })
    );
}

#[tokio::test]
#[serial_test::serial]
async fn compacts_the_generated_uis_of_a_database_thread_with_their_range() {
    let test = test_db();
    let ids = ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"];
    seed(&test, "ui-db", ThreadSource::Database, &ids);
    // A UI shown after m0, and one stored after the context was read. Neither is a
    // context row: the context replays a UI through its `show_ui` call.
    test.db
        .run_sync(|conn| {
            let start = Utc::now() - chrono::Duration::hours(1);
            for (id, millis) in [("ui-old", 500), ("ui-new", 7_500)] {
                let mut message = NewConversationMessage::new(
                    "ui-db".to_string(),
                    MessageRole::Agent,
                    "Deploys",
                    MessageTrigger::UserInput,
                );
                message.id = id.into();
                message.blocks = Some(json!([{ "type": "generated_ui", "id": id }]));
                message.created_at = (start + chrono::Duration::milliseconds(millis)).into();
                diesel::insert_into(conversation_messages::table)
                    .values(&message)
                    .execute(conn)?;
            }
            Ok(())
        })
        .unwrap();
    let events = capture("ui-db");
    let mut at_threshold = fork("ui-db", Scripted::answering("THE SUMMARY"));
    at_threshold.snapshot.used_percent = 90;

    COMPACTION_SERVICE.maybe_auto_compact(at_threshold);
    settled("ui-db").await;

    assert_eq!(compacted_ids(&test, "ui-db"), ["m0", "ui-old", "m1"]);
    // The estimate counts the summary and the tail alone.
    let last = events.lock().last().cloned().unwrap();
    assert_eq!(last.tokens_after, Some(Some((11 + 600 + 3) / 4)));
}

#[tokio::test]
#[serial_test::serial]
async fn advances_the_watermark_of_a_live_read_thread_and_flags_only_the_database_rows() {
    let test = test_db();
    seed(
        &test,
        "auto-slack",
        ThreadSource::Slack,
        &["p0", "i0", "s0"],
    );
    let model = Scripted::answering("THE SUMMARY");
    let mut live = fork("auto-slack", model);
    let mut context = vec![
        // The press of a generated UI button: a stored user row with no Slack ts.
        row("p0", true, 50),
        ForkRow {
            external_message_id: Some("1700.0002".into()),
            ..row("s0", false, 50)
        },
        ForkRow {
            internal_step: true,
            ..row("i0", false, 50)
        },
    ];
    // Enough replies after the press that the kept tail starts on the newest request.
    context.extend((3..8).map(|i| ForkRow {
        external_message_id: Some(format!("1700.000{i}")),
        ..row(&format!("r{i}"), false, 50)
    }));
    live.fork.context_rows = context;
    live.fork.context_rows.extend([
        ForkRow {
            external_message_id: Some("1700.0010".into()),
            ..row("s1", false, 50)
        },
        ForkRow {
            external_message_id: Some("1700.0011".into()),
            ..row("s2", true, 50)
        },
    ]);

    COMPACTION_SERVICE.maybe_auto_compact(live);
    settled("auto-slack").await;

    // Rows read from the channel have synthesized ids that match nothing in the
    // database: only the internal-step and press rows are flag-flipped.
    assert_eq!(compacted_ids(&test, "auto-slack"), ["p0", "i0"]);
    let (summary, through, _) = stored_thread(&test, "auto-slack");
    assert_eq!(summary.as_deref(), Some("THE SUMMARY"));
    assert_eq!(through.as_deref(), Some("1700.0010"));
}

#[tokio::test]
#[serial_test::serial]
async fn writes_nothing_and_reports_a_failure_when_the_summary_is_empty_or_cut_off() {
    for (thread_id, response, error) in [
        (
            "fail-empty",
            answer("   ", FinishReason::Stop),
            "The model returned an empty summary.",
        ),
        (
            "fail-cut",
            answer("## Goal\n- half a summ", FinishReason::Length),
            "The summary was cut off at the output limit, so nothing was compacted.",
        ),
    ] {
        let test = test_db();
        seed(
            &test,
            thread_id,
            ThreadSource::Database,
            &["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"],
        );
        let events = capture(thread_id);
        COMPACTION_SERVICE.maybe_auto_compact(fork(thread_id, Scripted::new(vec![Ok(response)])));
        settled(thread_id).await;

        assert!(compacted_ids(&test, thread_id).is_empty());
        assert_eq!(stored_thread(&test, thread_id).0, None);
        assert_eq!(
            statuses(&events),
            [CompactionStatus::Started, CompactionStatus::Failed]
        );
        assert_eq!(events.lock()[1].error.as_deref(), Some(error));
    }
}

#[tokio::test]
#[serial_test::serial]
async fn reports_a_failure_and_never_fails_when_the_summarize_call_rejects() {
    let test = test_db();
    seed(&test, "fail-call", ThreadSource::Database, &["m0", "m1"]);
    let events = capture("fail-call");
    let model = Scripted::new(vec![Err(anyhow::anyhow!("model unavailable"))]);
    COMPACTION_SERVICE.maybe_auto_compact(fork("fail-call", model));
    settled("fail-call").await;

    let last = events.lock().last().cloned().unwrap();
    assert_eq!(last.status, CompactionStatus::Failed);
    assert!(last.error.unwrap().contains("model unavailable"));
    assert!(compacted_ids(&test, "fail-call").is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_a_previous_summary_when_overflow_recovery_shrinks_the_history() {
    let test = test_db();
    seed(
        &test,
        "overflow-keep",
        ThreadSource::Database,
        &["m0", "m1"],
    );
    let model = Scripted::new(vec![
        Err(anyhow::anyhow!(
            "prompt is too long: 1200000 tokens > 1000000 maximum"
        )),
        Ok(answer("THE SUMMARY", FinishReason::Stop)),
    ]);
    let mut overflow = fork("overflow-keep", Arc::clone(&model)).fork;
    overflow.messages = vec![
        ModelMessage::user("<conversation-summary>\nearlier"),
        ModelMessage::user("q1"),
        ModelMessage::assistant("a1"),
        ModelMessage::user("q2"),
        ModelMessage::assistant("a2"),
    ];

    COMPACTION_SERVICE.maybe_compact_after_overflow(overflow);
    settled("overflow-keep").await;

    assert_eq!(model.call_count(), 2);
    let retried = prompt_json(&model.call(1));
    let texts: Vec<&str> = retried
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] != json!("system"))
        .map(|m| m["content"][0]["text"].as_str().unwrap())
        .collect();
    assert_eq!(
        texts,
        [
            "<conversation-summary>\nearlier",
            "q2",
            "a2",
            COMPACTION_PROMPT
        ]
    );
    assert_eq!(model.call(1).max_output_tokens, Some(MAX_OUTPUT_TOKENS));
    assert_eq!(compacted_ids(&test, "overflow-keep"), ["m0", "m1"]);
}

#[tokio::test]
#[serial_test::serial]
async fn fails_without_retrying_on_a_summarize_error_that_is_no_overflow() {
    let test = test_db();
    seed(
        &test,
        "overflow-other",
        ThreadSource::Database,
        &["m0", "m1"],
    );
    let events = capture("overflow-other");
    let model = Scripted::new(vec![Err(anyhow::anyhow!("model unavailable"))]);
    COMPACTION_SERVICE
        .maybe_compact_after_overflow(fork("overflow-other", Arc::clone(&model)).fork);
    settled("overflow-other").await;

    assert_eq!(model.call_count(), 1);
    assert_eq!(
        events.lock().last().map(|event| event.status),
        Some(CompactionStatus::Failed)
    );
}

// ---------------------------------------------------------------------------
// has_compactable_history
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial_test::serial]
async fn has_compactable_history_counts_the_uncompacted_rows_of_a_database_thread() {
    let test = test_db();
    seed(&test, "precheck-db", ThreadSource::Database, &["m0"]);
    seed_thread_only(&test, "precheck-empty", ThreadSource::Database);
    seed_thread_only(&test, "precheck-slack", ThreadSource::Slack);
    assert!(
        COMPACTION_SERVICE
            .has_compactable_history("precheck-db")
            .await
            .unwrap()
    );
    assert!(
        !COMPACTION_SERVICE
            .has_compactable_history("precheck-empty")
            .await
            .unwrap()
    );
    // Channel-backed threads pass through: their history lives in the channel.
    assert!(
        COMPACTION_SERVICE
            .has_compactable_history("precheck-slack")
            .await
            .unwrap()
    );
}

/// A thread on a model with no known window (so the 1M fallback) and one stored row
/// of `chars` characters, compacted `compacted_after_row` or never.
fn seed_stored_run(
    test: &TestDb,
    thread_id: &str,
    source: ThreadSource,
    chars: usize,
    compacted_after_row: bool,
) {
    let thread_id = thread_id.to_string();
    test.db
        .run_sync(move |conn| {
            let mut thread = NewConversationThread::new("test-agent-id", "user-1");
            thread.id = thread_id.clone();
            thread.thread_source = source;
            thread.context_tokens = Some(12_345);
            thread.context_model = Some("model-with-no-known-window".into());
            if compacted_after_row {
                thread.compacted_at = Some(Utc::now());
            }
            diesel::insert_into(conversation_threads::table)
                .values(&thread)
                .execute(conn)?;
            let mut message = NewConversationMessage::new(
                thread_id.clone(),
                MessageRole::Agent,
                "x".repeat(chars),
                MessageTrigger::CronTask,
            );
            message.created_at = (Utc::now() - chrono::Duration::minutes(5)).into();
            diesel::insert_into(conversation_messages::table)
                .values(&message)
                .execute(conn)?;
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
#[serial_test::serial]
async fn sizes_a_stored_run_as_the_last_measurement_plus_the_rows_stored_since() {
    let test = test_db();
    // The agent the threads belong to.
    seed(&test, "stored-agent", ThreadSource::Database, &[]);
    // 90% of the 1M fallback window is 900k tokens, 3.6M characters.
    seed_stored_run(
        &test,
        "stored-over",
        ThreadSource::Database,
        3_700_000,
        false,
    );
    seed_stored_run(
        &test,
        "stored-under",
        ThreadSource::Database,
        3_500_000,
        false,
    );
    seed_stored_run(
        &test,
        "stored-measured",
        ThreadSource::Database,
        3_700_000,
        true,
    );
    seed_stored_run(&test, "stored-slack", ThreadSource::Slack, 3_700_000, false);
    // No turn or compaction measured it: sized from all its rows.
    assert_eq!(
        stored_growth("test-agent-id", "stored-over").await.unwrap(),
        Some(None)
    );
    assert_eq!(
        stored_growth("test-agent-id", "stored-under")
            .await
            .unwrap(),
        None
    );
    // The compaction after the row measured it, and nothing was stored since.
    assert_eq!(
        stored_growth("test-agent-id", "stored-measured")
            .await
            .unwrap(),
        None
    );
    // A live-read thread's history is in the channel.
    assert_eq!(
        stored_growth("test-agent-id", "stored-slack")
            .await
            .unwrap(),
        None
    );
}

#[test]
fn counts_a_stored_rows_text_tool_calls_and_blocks() {
    let rows = vec![
        ("abcd".to_string(), Some(json!([{ "a": 1 }])), None),
        ("é".to_string(), None, Some(json!({}))),
    ];
    // "abcd" + `[{"a":1}]` (9) + "é" (1) + `{}` (2)
    assert_eq!(stored_chars(&rows), 16);
}

fn seed_thread_only(test: &TestDb, thread_id: &str, source: ThreadSource) {
    let thread_id = thread_id.to_string();
    test.db
        .run_sync(move |conn| {
            let mut thread = NewConversationThread::new("test-agent-id", "user-1");
            thread.id = thread_id;
            thread.thread_source = source;
            diesel::insert_into(conversation_threads::table)
                .values(&thread)
                .execute(conn)?;
            Ok(())
        })
        .unwrap();
}

// ---------------------------------------------------------------------------
// split_tail
// ---------------------------------------------------------------------------

#[test]
fn starts_the_tail_on_a_user_message_never_on_the_reply_that_answers_it() {
    let rows = [
        row("u0", true, 100),
        row("a0", false, 100),
        row("u1", true, 100),
        row("a1", false, 100),
        row("a2", false, 100),
    ];
    let split = split_tail_at(&rows, 3);
    // Three newest rows would start on a reply; the tail backs off to u1.
    assert_eq!(tail_ids(&split), ["u1", "a1", "a2"]);
    let compactable: Vec<&str> = split.compactable.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(compactable, ["u0", "a0"]);
}

#[test]
fn leaves_out_a_reply_whose_tool_output_alone_exceeds_the_token_budget() {
    let rows = [
        row("u0", true, 100),
        row("a0", false, 500_000),
        row("u1", true, 100),
        row("a1", false, 100),
    ];
    assert_eq!(tail_ids(&split_tail(&rows)), ["u1", "a1"]);
}

#[test]
fn keeps_the_newest_request_when_its_reply_alone_has_more_step_rows_than_the_cap() {
    let mut rows = vec![
        row("u0", true, 100),
        row("a0", false, 100),
        row("u1", true, 100),
    ];
    rows.extend(["s1", "s2", "s3", "s4"].map(|id| row(id, false, 100)));
    assert_eq!(
        tail_ids(&split_tail_at(&rows, 3)),
        ["u1", "s1", "s2", "s3", "s4"]
    );
}

#[test]
fn starts_the_tail_on_the_request_not_on_the_recalled_memory_block_stored_after_it() {
    let mut rows = vec![
        row("u0", true, 100),
        row("a0", false, 100),
        row("u1", true, 100),
        ForkRow {
            internal_step: true,
            ..row("r1", false, 100)
        },
    ];
    rows.extend(["s1", "s2", "s3", "s4", "s5"].map(|id| row(id, false, 100)));
    assert_eq!(
        tail_ids(&split_tail_at(&rows, 6)),
        ["u1", "r1", "s1", "s2", "s3", "s4", "s5"]
    );
}

#[test]
fn keeps_the_newest_rows_that_fit_in_a_thread_with_no_user_message() {
    let rows: Vec<ForkRow> = ["g1", "g2", "g3", "g4", "g5"]
        .iter()
        .map(|id| row(id, false, 100))
        .collect();
    assert_eq!(tail_ids(&split_tail_at(&rows, 3)), ["g3", "g4", "g5"]);
}

#[test]
fn stops_at_the_token_budget_in_a_thread_with_no_user_message() {
    let rows = [
        row("g1", false, 100),
        row("g2", false, 100),
        row("g3", false, 500_000),
        row("g4", false, 100),
        row("g5", false, 100),
    ];
    assert_eq!(tail_ids(&split_tail(&rows)), ["g4", "g5"]);
}

#[test]
fn keeps_nothing_when_the_newest_row_of_such_a_thread_is_over_the_budget() {
    let rows = [row("g1", false, 100), row("g2", false, 500_000)];
    assert!(split_tail(&rows).tail.is_empty());
}

#[test]
fn reads_a_recalled_memory_block_stored_in_a_user_row_as_no_request() {
    let messages: Vec<HistoryRow> = serde_json::from_value(json!([
        { "id": "r1", "role": "USER", "internalStep": true, "content": "<recalled-memories>" },
        { "id": "u1", "role": "USER", "content": "deploy it" },
        {
            "id": "a1",
            "role": "AGENT",
            "content": "ünï",
            "toolCalls": [{ "tool": "x", "input": "{}", "output": "😀" }],
        },
    ]))
    .unwrap();
    let rows = to_fork_rows(&messages);
    assert!(!rows[0].from_user);
    assert!(rows[0].internal_step);
    assert!(rows[1].from_user);
    // UTF-16 lengths: the text and the JSON of the tool calls.
    let calls = r#"[{"tool":"x","input":"{}","output":"😀"}]"#;
    assert_eq!(
        rows[2].content_chars,
        3 + calls.encode_utf16().count() as i64
    );
}

#[test]
fn summarizes_everything_with_a_tail_of_0() {
    let rows = [row("u0", true, 100), row("a0", false, 100)];
    let split = split_tail_at(&rows, 0);
    assert_eq!(split.compactable, rows.to_vec());
    assert!(split.tail.is_empty());
}

#[test]
fn summarizes_everything_when_even_the_newest_exchange_does_not_fit() {
    let rows = [
        row("u0", true, 100),
        row("a0", false, 100),
        row("u1", true, 100),
        row("a1", false, 500_000),
    ];
    let split = split_tail(&rows);
    assert!(split.tail.is_empty());
    assert_eq!(split.compactable.len(), 4);
}

// ---------------------------------------------------------------------------
// shrinking an overflowing history, and the output budget
// ---------------------------------------------------------------------------

fn texts(messages: &[ModelMessage]) -> Vec<String> {
    messages
        .iter()
        .map(|m| {
            serde_json::to_value(m).unwrap()["content"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

#[test]
fn drops_the_oldest_quarter_and_re_anchors_on_a_user_message() {
    let history = [
        ModelMessage::user("q1"),
        ModelMessage::assistant("a1"),
        ModelMessage::user("q2"),
        ModelMessage::assistant("a2"),
        ModelMessage::user("q3"),
    ];
    assert_eq!(
        texts(&shrink_history_head(&history).unwrap()),
        ["q2", "a2", "q3"]
    );
}

#[test]
fn drops_the_summary_last_when_nothing_else_is_left_to_drop() {
    let history = [
        ModelMessage::user("<conversation-summary>\nhuge"),
        ModelMessage::user("q1"),
        ModelMessage::assistant("a1"),
    ];
    // Behind the summary there is one exchange, which a quarter-cut cannot shorten.
    assert_eq!(texts(&shrink_history_head(&history).unwrap()), ["q1", "a1"]);
    assert_eq!(shrink_history_head(&[ModelMessage::user("q1")]), None);
    assert_eq!(
        shrink_history_head(&[ModelMessage::assistant("a1"), ModelMessage::assistant("a2")]),
        None
    );
}

#[test]
fn reads_only_a_plain_user_message_that_opens_with_the_tag_as_the_summary() {
    assert!(is_summary_message(Some(&ModelMessage::user(
        "<conversation-summary>\nx"
    ))));
    assert!(!is_summary_message(Some(&ModelMessage::assistant(
        "<conversation-summary>"
    ))));
    assert!(!is_summary_message(Some(&ModelMessage::user("hello"))));
    assert!(!is_summary_message(None));
}

#[test]
fn asks_for_no_more_output_than_the_window_has_room_for() {
    assert_eq!(summary_output_budget(Some(200_000), Some(186_000)), 10_000);
    assert_eq!(
        summary_output_budget(Some(1_000_000), Some(900_000)),
        MAX_OUTPUT_TOKENS
    );
    assert_eq!(
        summary_output_budget(Some(200_000), Some(199_000)),
        MIN_SUMMARY_OUTPUT_TOKENS
    );
    assert_eq!(summary_output_budget(None, Some(1)), MAX_OUTPUT_TOKENS);
    assert_eq!(summary_output_budget(Some(0), Some(1)), MAX_OUTPUT_TOKENS);
    assert_eq!(
        summary_output_budget(Some(200_000), None),
        MAX_OUTPUT_TOKENS
    );
}

#[test]
fn reads_a_slack_timestamp_as_parse_float_does() {
    assert_eq!(js_parse_float("1700.0010"), 1700.001);
    assert_eq!(js_parse_float(" 12abc"), 12.0);
    assert!(js_parse_float("abc").is_nan());
}
