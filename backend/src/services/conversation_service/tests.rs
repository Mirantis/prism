//! Conversation service tests, on a database built from the committed migrations.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::TimeZone;
use diesel::prelude::*;
use serde_json::json;

use super::*;
use crate::db::models::NewAgentWorkspace;
use crate::db::schema::agent_workspaces;

const AGENT: &str = "agent-123";
const USER: &str = "user-123";

fn at(second: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 8, 8, 0, second).unwrap()
}

async fn seed_agent() {
    crate::db::run(|conn| {
        let mut agent = NewAgentWorkspace::new(USER, "", "", "", "", "");
        agent.id = AGENT.into();
        diesel::insert_into(agent_workspaces::table)
            .values(&agent)
            .execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
}

/// A thread created at `second`, with whatever `edit` sets.
async fn thread(
    id: &str,
    second: u32,
    edit: impl FnOnce(&mut NewConversationThread) + Send + 'static,
) {
    let mut row = NewConversationThread::new(AGENT, USER);
    row.id = id.into();
    row.created_at = DbDateTime(at(second));
    row.updated_at = DbDateTime(at(second));
    edit(&mut row);
    crate::db::run(move |conn| {
        diesel::insert_into(t::conversation_threads)
            .values(&row)
            .execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
}

fn call(id: &str) -> Value {
    json!({ "id": id, "tool": format!("tool-{id}"), "input": "{}", "output": "ok", "success": true })
}

/// A message row in `thread_id`, created at `second`.
#[allow(clippy::too_many_arguments)]
async fn message(
    thread_id: &str,
    id: &str,
    role: MessageRole,
    second: u32,
    tool_calls: Option<Value>,
    internal_step: bool,
    triggered_by: MessageTrigger,
) {
    let mut row = NewConversationMessage::new(thread_id, role, id, triggered_by);
    row.id = id.into();
    row.created_at = DbDateTime(at(second));
    row.tool_calls = tool_calls;
    row.internal_step = internal_step;
    crate::db::run(move |conn| {
        diesel::insert_into(m::conversation_messages)
            .values(&row)
            .execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
}

async fn user(thread_id: &str, id: &str, second: u32) {
    message(
        thread_id,
        id,
        MessageRole::User,
        second,
        None,
        false,
        MessageTrigger::UserInput,
    )
    .await;
}

async fn agent(thread_id: &str, id: &str, second: u32, calls: &[&str]) {
    let tool_calls =
        (!calls.is_empty()).then(|| Value::Array(calls.iter().map(|c| call(c)).collect()));
    message(
        thread_id,
        id,
        MessageRole::Agent,
        second,
        tool_calls,
        false,
        MessageTrigger::UserInput,
    )
    .await;
}

async fn step(thread_id: &str, id: &str, second: u32, calls: &[&str]) {
    let tool_calls =
        (!calls.is_empty()).then(|| Value::Array(calls.iter().map(|c| call(c)).collect()));
    message(
        thread_id,
        id,
        MessageRole::Agent,
        second,
        tool_calls,
        true,
        MessageTrigger::UserInput,
    )
    .await;
}

fn call_ids(message: Option<&ConversationMessage>) -> Vec<String> {
    message
        .and_then(|m| m.tool_calls.as_ref())
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .map(|c| c["id"].as_str().unwrap().to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn find<'a>(
    messages: &'a [WithSender<ConversationMessage>],
    id: &str,
) -> Option<&'a ConversationMessage> {
    messages.iter().find(|m| m.id == id).map(|m| &m.inner)
}

/// Single-thread mode for the life of the guard.
struct SingleThreadMode;

impl SingleThreadMode {
    fn on() -> Self {
        *testing::THREAD_MODE.lock() = Some(ThreadMode::Single);
        SingleThreadMode
    }
}

impl Drop for SingleThreadMode {
    fn drop(&mut self) {
        *testing::THREAD_MODE.lock() = None;
    }
}

#[tokio::test]
#[serial_test::serial]
async fn lists_the_newest_threads_first_up_to_the_limit() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    for (i, id) in ["t1", "t2", "t3"].into_iter().enumerate() {
        thread(id, i as u32, |_| {}).await;
    }
    let all = CONVERSATION_SERVICE
        .list_threads(USER, AGENT, None)
        .await
        .unwrap();
    assert_eq!(
        all.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["t3", "t2", "t1"]
    );
    let two = CONVERSATION_SERVICE
        .list_threads(
            USER,
            AGENT,
            Some(ListThreadsOptions {
                limit: Some(2),
                thread_source: None,
                workspace_root: None,
            }),
        )
        .await
        .unwrap();
    assert_eq!(two.len(), 2);
}

#[tokio::test]
#[serial_test::serial]
async fn with_a_workspace_root_lists_the_threads_rooted_in_that_folder() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("a-old", 1, |t| t.workspace_root = Some("/repo/a".into())).await;
    thread("b", 2, |t| t.workspace_root = Some("/repo/b".into())).await;
    thread("a-new", 3, |t| t.workspace_root = Some("/repo/a".into())).await;
    thread("none", 4, |_| {}).await;
    let threads = CONVERSATION_SERVICE
        .list_threads(
            USER,
            AGENT,
            Some(ListThreadsOptions {
                limit: Some(1),
                thread_source: Some(ThreadSource::Database),
                workspace_root: Some("/repo/a".into()),
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        threads.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["a-new"]
    );
}

#[tokio::test]
#[serial_test::serial]
async fn lists_database_threads_without_the_ones_a_channel_keys() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("web", 1, |_| {}).await;
    thread("dm", 2, |t| t.external_thread_id = Some("D123".into())).await;
    thread("slack", 3, |t| {
        t.external_thread_id = Some("C1:1".into());
        t.thread_source = ThreadSource::Slack;
    })
    .await;
    let database = CONVERSATION_SERVICE
        .list_threads(
            USER,
            AGENT,
            Some(ListThreadsOptions {
                limit: None,
                thread_source: Some(ThreadSource::Database),
                workspace_root: None,
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        database.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["web"]
    );
    let slack = CONVERSATION_SERVICE
        .list_threads(
            USER,
            AGENT,
            Some(ListThreadsOptions {
                limit: None,
                thread_source: Some(ThreadSource::Slack),
                workspace_root: None,
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        slack.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["slack"]
    );
}

#[tokio::test]
#[serial_test::serial]
async fn answers_the_id_of_an_owned_thread_only() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("t1", 1, |_| {}).await;
    assert_eq!(
        CONVERSATION_SERVICE
            .get_owned_thread_id(USER, AGENT, "t1")
            .await
            .unwrap()
            .as_deref(),
        Some("t1")
    );
    assert_eq!(
        CONVERSATION_SERVICE
            .get_owned_thread_id("someone-else", AGENT, "t1")
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        CONVERSATION_SERVICE
            .get_owned_thread_id(USER, AGENT, "missing")
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
#[serial_test::serial]
async fn reads_a_web_thread_only_since_a_channel_thread_is_read_in_its_channel() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("stored-channel", 1, |t| {
        t.external_thread_id = Some("1700000000.000100".into())
    })
    .await;
    thread("thread-slack", 2, |t| {
        t.external_thread_id = Some("C1:1.0".into());
        t.thread_source = ThreadSource::Slack;
    })
    .await;
    for id in ["stored-channel", "thread-slack"] {
        assert_eq!(
            CONVERSATION_SERVICE
                .get_owned_thread_id(USER, AGENT, id)
                .await
                .unwrap(),
            None,
            "{id}"
        );
        assert!(
            CONVERSATION_SERVICE
                .get_thread(USER, AGENT, id, None)
                .await
                .unwrap()
                .is_none(),
            "{id}"
        );
    }
}

#[tokio::test]
#[serial_test::serial]
async fn returns_the_latest_web_thread_or_creates_one_and_announces_it() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    let created = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let sink = Arc::clone(&created);
    CONVERSATION_SERVICE
        .events
        .on_thread(move |event| sink.lock().push(event.thread_id.clone()));

    let fresh = CONVERSATION_SERVICE
        .get_or_create_latest_thread(AGENT, USER)
        .await
        .unwrap();
    assert!(created.lock().contains(&fresh.id));
    let again = CONVERSATION_SERVICE
        .get_or_create_latest_thread(AGENT, USER)
        .await
        .unwrap();
    assert_eq!(again.id, fresh.id);
    assert_eq!(
        created.lock().iter().filter(|id| **id == fresh.id).count(),
        1
    );
}

#[tokio::test]
#[serial_test::serial]
async fn reuses_the_newest_thread_only_while_it_is_untouched_and_not_rooted() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("empty", 1, |_| {}).await;
    let reused = CONVERSATION_SERVICE
        .get_or_create_fresh_thread(AGENT, USER)
        .await
        .unwrap();
    assert_eq!(reused.id, "empty");

    user("empty", "hello", 2).await;
    let created = CONVERSATION_SERVICE
        .get_or_create_fresh_thread(AGENT, USER)
        .await
        .unwrap();
    assert_ne!(created.id, "empty");

    let rooted = CONVERSATION_SERVICE
        .start_new_thread(
            AGENT,
            USER,
            Some(StartThreadOptions {
                workspace_root: Some("/repo".into()),
            }),
        )
        .await
        .unwrap();
    let next = CONVERSATION_SERVICE
        .get_or_create_fresh_thread(AGENT, USER)
        .await
        .unwrap();
    assert_ne!(next.id, rooted.id);
}

#[tokio::test]
#[serial_test::serial]
async fn persists_a_workspace_root_and_ignores_a_blank_one() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    let rooted = CONVERSATION_SERVICE
        .start_new_thread(
            AGENT,
            USER,
            Some(StartThreadOptions {
                workspace_root: Some("  /repo  ".into()),
            }),
        )
        .await
        .unwrap();
    assert_eq!(rooted.workspace_root.as_deref(), Some("/repo"));
    assert_eq!(
        CONVERSATION_SERVICE
            .get_thread_workspace_root(&rooted.id)
            .await
            .unwrap()
            .as_deref(),
        Some("/repo")
    );
    let blank = CONVERSATION_SERVICE
        .start_new_thread(
            AGENT,
            USER,
            Some(StartThreadOptions {
                workspace_root: Some("   ".into()),
            }),
        )
        .await
        .unwrap();
    assert_eq!(blank.workspace_root, None);
    assert_eq!(
        CONVERSATION_SERVICE
            .get_thread_workspace_root("missing")
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
#[serial_test::serial]
async fn names_the_thread_after_the_first_user_message_once() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("t1", 1, |_| {}).await;

    let mut file_only = MessageInput::new("", MessageRole::User, MessageTrigger::UserInput);
    file_only.id = Some("file-only".into());
    assert_eq!(
        CONVERSATION_SERVICE
            .add_message("t1", file_only)
            .await
            .unwrap()
            .title_set,
        None
    );

    let mut internal = MessageInput::new(
        "recalled memories",
        MessageRole::User,
        MessageTrigger::UserInput,
    );
    internal.internal_step = Some(true);
    assert_eq!(
        CONVERSATION_SERVICE
            .add_message("t1", internal)
            .await
            .unwrap()
            .title_set,
        None
    );

    let reply = MessageInput::new(
        "an agent answer",
        MessageRole::Agent,
        MessageTrigger::UserInput,
    );
    assert_eq!(
        CONVERSATION_SERVICE
            .add_message("t1", reply)
            .await
            .unwrap()
            .title_set,
        None
    );

    let mut first = MessageInput::new(
        "migrate the authentication layer",
        MessageRole::User,
        MessageTrigger::UserInput,
    );
    first.id = Some("chosen-id".into());
    let added = CONVERSATION_SERVICE.add_message("t1", first).await.unwrap();
    assert_eq!(added.message.id, "chosen-id");
    assert_eq!(added.title_set.as_deref(), Some("migrate the authentic..."));

    let second = MessageInput::new("and another", MessageRole::User, MessageTrigger::UserInput);
    assert_eq!(
        CONVERSATION_SERVICE
            .add_message("t1", second)
            .await
            .unwrap()
            .title_set,
        None
    );
}

#[tokio::test]
#[serial_test::serial]
async fn hides_internal_steps_from_client_history_and_keeps_them_for_the_model() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("t1", 1, |_| {}).await;
    user("t1", "question", 1).await;
    step("t1", "step", 2, &["a"]).await;
    agent("t1", "answer", 3, &["own"]).await;

    let recent = CONVERSATION_SERVICE
        .get_recent_messages("t1", 20, None)
        .await
        .unwrap();
    assert_eq!(
        recent.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["question", "answer"]
    );
    // The model replays each call once, from its own step.
    let context = CONVERSATION_SERVICE.get_thread_context("t1").await.unwrap();
    let replayed: Vec<String> = context
        .messages
        .iter()
        .flat_map(|m| call_ids(Some(m)))
        .collect();
    assert_eq!(replayed, ["a", "own"]);
    assert_eq!(context.thread_source, ThreadSource::Database);
}

#[tokio::test]
#[serial_test::serial]
async fn names_each_sender_as_the_chat_socket_does() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("t1", 1, |_| {}).await;
    let mut from_ada = MessageInput::new("hi", MessageRole::User, MessageTrigger::UserInput);
    from_ada.sender_external_id = Some("ada@example.com".into());
    CONVERSATION_SERVICE
        .add_message("t1", from_ada)
        .await
        .unwrap();
    let recent = CONVERSATION_SERVICE
        .get_recent_messages("t1", 20, None)
        .await
        .unwrap();
    let shown = serde_json::to_value(&recent[0]).unwrap();
    assert_eq!(shown["senderId"], "ada@example.com");
    assert_eq!(shown["agentMessageKind"], Value::Null);
}

#[tokio::test]
#[serial_test::serial]
async fn shows_a_concise_turns_hidden_calls_on_its_answer_ahead_of_its_own() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("t1", 1, |_| {}).await;
    user("t1", "question", 1).await;
    step("t1", "step-1", 2, &["a"]).await;
    step("t1", "step-2", 3, &["b"]).await;
    agent("t1", "answer", 4, &["own"]).await;

    let recent = CONVERSATION_SERVICE
        .get_recent_messages("t1", 10, None)
        .await
        .unwrap();
    assert_eq!(call_ids(find(&recent, "answer")), ["a", "b", "own"]);
    // A page that starts at the answer shows what the whole history shows.
    let page = CONVERSATION_SERVICE
        .get_recent_messages("t1", 1, None)
        .await
        .unwrap();
    assert_eq!(call_ids(find(&page, "answer")), ["a", "b", "own"]);
}

#[tokio::test]
#[serial_test::serial]
async fn shows_a_cancelled_turns_calls_nowhere() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("t1", 1, |_| {}).await;
    user("t1", "question", 1).await;
    step("t1", "cancelled-step", 2, &["stale"]).await;
    message(
        "t1",
        "agent-message",
        MessageRole::User,
        3,
        None,
        false,
        MessageTrigger::AgentMessage,
    )
    .await;
    step("t1", "step", 4, &["fresh"]).await;
    agent("t1", "answer", 5, &["own"]).await;

    let recent = CONVERSATION_SERVICE
        .get_recent_messages("t1", 10, None)
        .await
        .unwrap();
    assert_eq!(call_ids(find(&recent, "answer")), ["fresh", "own"]);
    assert!(find(&recent, "agent-message").unwrap().tool_calls.is_none());
}

#[tokio::test]
#[serial_test::serial]
async fn passes_over_a_heartbeat_mid_turn_and_skips_a_step_with_no_call() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("t1", 1, |_| {}).await;
    user("t1", "question", 1).await;
    step("t1", "narration", 2, &[]).await;
    message(
        "t1",
        "heartbeat",
        MessageRole::Agent,
        3,
        None,
        false,
        MessageTrigger::Heartbeat,
    )
    .await;
    // Written in the same second as the answer.
    step("t1", "last-step", 4, &["a"]).await;
    agent("t1", "answer", 4, &[]).await;

    let recent = CONVERSATION_SERVICE
        .get_recent_messages("t1", 10, None)
        .await
        .unwrap();
    assert!(find(&recent, "heartbeat").unwrap().tool_calls.is_none());
    assert_eq!(call_ids(find(&recent, "answer")), ["a"]);
}

#[tokio::test]
#[serial_test::serial]
async fn makes_no_change_to_a_persons_message_alone() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("t1", 1, |_| {}).await;
    user("t1", "question", 1).await;
    let rows = CONVERSATION_SERVICE
        .get_thread_context("t1")
        .await
        .unwrap()
        .messages;
    let shown = CONVERSATION_SERVICE
        .with_hidden_step_tool_calls("t1", rows.clone())
        .await
        .unwrap();
    assert_eq!(shown, rows);
}

/// A live-read provider that serves the rows it was given.
struct LiveRows(Vec<ConversationMessage>);

#[async_trait]
impl ThreadMessageProvider for LiveRows {
    async fn get_messages(
        &self,
        _thread_id: &str,
        _opts: Option<&MessageReadOptions>,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        Ok(self.0.clone())
    }

    async fn get_recent_messages(
        &self,
        _thread_id: &str,
        _limit: i64,
        _opts: Option<&MessageReadOptions>,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        Ok(self.0.clone())
    }
}

#[tokio::test]
#[serial_test::serial]
async fn reads_a_thread_through_the_provider_registered_for_its_source() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("live", 1, |t| {
        t.thread_source = ThreadSource::Slack;
        t.external_thread_id = Some("conversation".into());
    })
    .await;
    user("live", "stored-question", 1).await;
    step("live", "step", 2, &["a"]).await;
    agent("live", "stored-answer", 3, &[]).await;
    let served = CONVERSATION_SERVICE
        .get_thread_context("live")
        .await
        .unwrap()
        .messages;
    let live: Vec<ConversationMessage> = served.into_iter().filter(|m| !m.internal_step).collect();
    CONVERSATION_SERVICE.register_thread_provider(ThreadSource::Slack, Arc::new(LiveRows(live)));

    let recent = CONVERSATION_SERVICE
        .get_recent_messages("live", 10, None)
        .await
        .unwrap();
    // A reload of a live-read thread shows the calls the live reply showed.
    assert_eq!(call_ids(find(&recent, "stored-answer")), ["a"]);
}

#[tokio::test]
#[serial_test::serial]
async fn derives_the_context_usage_of_a_thread_for_clients() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("t1", 1, |_| {}).await;
    let before = CONVERSATION_SERVICE
        .get_thread(USER, AGENT, "t1", None)
        .await
        .unwrap()
        .unwrap();
    assert!(before.context_usage.is_none());
    CONVERSATION_SERVICE
        .set_thread_context_usage("t1", 12_000, "anthropic.claude-3-sonnet-20240229-v1:0")
        .await
        .unwrap();
    assert_eq!(
        CONVERSATION_SERVICE
            .get_thread_context_tokens("t1")
            .await
            .unwrap(),
        Some(12_000)
    );
    // A thread deleted mid-turn is no error.
    CONVERSATION_SERVICE
        .set_thread_context_usage("missing", 1, "m")
        .await
        .unwrap();
    CONVERSATION_SERVICE
        .set_thread_context_usage("t1", 1, "a-model-nobody-knows")
        .await
        .unwrap();
    let unknown = CONVERSATION_SERVICE
        .get_thread(USER, AGENT, "t1", None)
        .await
        .unwrap()
        .unwrap();
    assert!(unknown.context_usage.is_none());
}

#[tokio::test]
#[serial_test::serial]
async fn upserts_a_thread_by_its_external_id() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    let created = CONVERSATION_SERVICE
        .get_or_create_thread_by_external_id(USER, AGENT, "C1:1", None)
        .await
        .unwrap();
    assert_eq!(created.thread_source, ThreadSource::Database);
    assert_eq!(created.created_at, created.updated_at);
    let found = CONVERSATION_SERVICE
        .get_or_create_thread_by_external_id(
            USER,
            AGENT,
            "C1:1",
            Some(LiveThread {
                source: ThreadSource::Slack,
                channel_id: "C1".into(),
            }),
        )
        .await
        .unwrap();
    assert_eq!(found.id, created.id);
    assert_eq!(found.thread_source, ThreadSource::Slack);
    assert_eq!(found.external_channel_id.as_deref(), Some("C1"));
    assert_eq!(
        CONVERSATION_SERVICE
            .find_thread_by_external_id(USER, AGENT, "C1:1")
            .await
            .unwrap()
            .map(|t| t.id),
        Some(created.id)
    );
}

#[tokio::test]
#[serial_test::serial]
async fn tells_whether_two_people_wrote_in_a_thread() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("t1", 1, |_| {}).await;
    for sender in ["ada", "ada"] {
        let mut row = MessageInput::new("hi", MessageRole::User, MessageTrigger::UserInput);
        row.sender_external_id = Some(sender.into());
        CONVERSATION_SERVICE.add_message("t1", row).await.unwrap();
    }
    assert!(
        !CONVERSATION_SERVICE
            .has_several_senders("t1")
            .await
            .unwrap()
    );
    let mut grace = MessageInput::new("hi", MessageRole::User, MessageTrigger::UserInput);
    grace.sender_external_id = Some("grace".into());
    CONVERSATION_SERVICE.add_message("t1", grace).await.unwrap();
    assert!(
        CONVERSATION_SERVICE
            .has_several_senders("t1")
            .await
            .unwrap()
    );
}

#[tokio::test]
#[serial_test::serial]
async fn reads_the_oldest_message_that_is_not_an_internal_step() {
    let _db = crate::db::testing::test_db();
    seed_agent().await;
    thread("t1", 1, |_| {}).await;
    step("t1", "hidden", 1, &[]).await;
    user("t1", "first", 2).await;
    assert_eq!(
        CONVERSATION_SERVICE
            .get_first_message("t1")
            .await
            .unwrap()
            .map(|m| m.id)
            .as_deref(),
        Some("first")
    );
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_the_conversation_the_person_wrote_in_last_and_stores_it() {
    let _db = crate::db::testing::test_db();
    let _mode = SingleThreadMode::on();
    seed_agent().await;
    thread("thread-written", 1, |_| {}).await;
    thread("thread-newer", 2, |_| {}).await;
    user("thread-written", "hello", 3).await;

    let chosen = CONVERSATION_SERVICE
        .find_latest_web_thread(AGENT, USER)
        .await
        .unwrap();
    assert_eq!(chosen.map(|t| t.id).as_deref(), Some("thread-written"));
    assert_eq!(
        RUNTIME_STATE_SERVICE
            .get(SINGLE_THREAD)
            .await
            .unwrap()
            .as_deref(),
        Some("thread-written")
    );

    // The stored conversation holds when the person writes in another thread.
    user("thread-newer", "elsewhere", 4).await;
    let kept = CONVERSATION_SERVICE
        .find_latest_web_thread(AGENT, USER)
        .await
        .unwrap();
    assert_eq!(kept.map(|t| t.id).as_deref(), Some("thread-written"));

    // A request for a new thread is answered with the one conversation.
    let started = CONVERSATION_SERVICE
        .start_new_thread(
            AGENT,
            USER,
            Some(StartThreadOptions {
                workspace_root: Some("/repo".into()),
            }),
        )
        .await
        .unwrap();
    assert_eq!(started.id, "thread-written");
    // A run named for another web thread writes to the one conversation.
    assert_eq!(
        CONVERSATION_SERVICE
            .writable_thread_id("thread-newer")
            .await
            .unwrap(),
        "thread-written"
    );
    // Only the one conversation is listed and opened among web threads.
    let listed = CONVERSATION_SERVICE
        .list_threads(USER, AGENT, None)
        .await
        .unwrap();
    assert_eq!(
        listed.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["thread-written"]
    );
    assert_eq!(
        CONVERSATION_SERVICE
            .get_owned_thread_id(USER, AGENT, "thread-newer")
            .await
            .unwrap(),
        None
    );

    CONVERSATION_SERVICE.forget_single_thread().await.unwrap();
    assert_eq!(
        RUNTIME_STATE_SERVICE.get(SINGLE_THREAD).await.unwrap(),
        None
    );
}

#[tokio::test]
#[serial_test::serial]
async fn writes_a_channel_thread_as_named_in_single_thread_mode() {
    let _db = crate::db::testing::test_db();
    let _mode = SingleThreadMode::on();
    seed_agent().await;
    thread("thread-slack", 1, |t| {
        t.external_thread_id = Some("C123:1700000000.000100".into())
    })
    .await;
    assert_eq!(
        CONVERSATION_SERVICE
            .writable_thread_id("thread-slack")
            .await
            .unwrap(),
        "thread-slack"
    );
    assert_eq!(
        RUNTIME_STATE_SERVICE.get(SINGLE_THREAD).await.unwrap(),
        None
    );
}

#[tokio::test]
#[serial_test::serial]
async fn writes_to_the_named_thread_in_multi_thread_mode() {
    let _db = crate::db::testing::test_db();
    assert_eq!(
        CONVERSATION_SERVICE
            .writable_thread_id("thread-older")
            .await
            .unwrap(),
        "thread-older"
    );
}
