//! Conversation search, on a database built from the committed migrations.

use chrono::TimeZone;
use serde_json::json;

use super::*;
use crate::db::models::{
    MessageTrigger, NewAgentWorkspace, NewConversationMessage, NewConversationThread,
};
use crate::db::schema::{agent_workspaces, conversation_messages, conversation_threads};
use crate::tools::conversation_search::{
    ConversationSearchInput, ConversationSearchToolsInput, run_conversation_search,
};

const AGENT: &str = "agent-1";

fn at(minute: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 8, 8, minute, 0).unwrap()
}

async fn seed(threads: &[(&'static str, &'static str, Option<&'static str>)]) {
    let threads = threads.to_vec();
    crate::db::run(move |conn| {
        for agent_id in [AGENT, "other-agent"] {
            let mut agent = NewAgentWorkspace::new("user-1", "", "", "", "", "");
            agent.id = agent_id.into();
            diesel::insert_into(agent_workspaces::table)
                .values(&agent)
                .execute(conn)?;
        }
        for (id, agent_id, title) in threads {
            let mut thread = NewConversationThread::new(agent_id, "user-1");
            thread.id = id.into();
            thread.title = title.map(str::to_string);
            diesel::insert_into(conversation_threads::table)
                .values(&thread)
                .execute(conn)?;
        }
        Ok(())
    })
    .await
    .unwrap();
}

async fn stored(
    thread: &str,
    id: &str,
    minute: u32,
    role: MessageRole,
    content: &str,
    edit: impl FnOnce(&mut NewConversationMessage) + Send + 'static,
) {
    let mut row = NewConversationMessage::new(thread, role, content, MessageTrigger::UserInput);
    row.id = id.into();
    row.created_at = DbDateTime(at(minute));
    edit(&mut row);
    crate::db::run(move |conn| {
        diesel::insert_into(conversation_messages::table)
            .values(&row)
            .execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
}

/// A message as a channel's history read returns it.
fn read_from_channel(ts: &str, minute: u32, content: &str) -> ConversationMessage {
    ConversationMessage {
        id: format!("read-{ts}"),
        thread_id: "slack".into(),
        role: MessageRole::User,
        content: content.into(),
        triggered_by: MessageTrigger::UserInput,
        trigger_name: None,
        tool_calls: None,
        blocks: None,
        sender_external_id: Some("U1".into()),
        sender_name: Some("Dana".into()),
        external_message_id: Some(ts.into()),
        is_compacted: false,
        internal_step: false,
        created_at: at(minute),
    }
}

fn options(query: &str) -> SearchOptions {
    SearchOptions {
        query: query.into(),
        agent_id: AGENT.into(),
        limit: 5,
        ..SearchOptions::default()
    }
}

fn ids(outcome: &SearchOutcome) -> Vec<(String, i64)> {
    outcome
        .matches
        .iter()
        .map(|found| (found.message.id.clone(), found.message.position))
        .collect()
}

#[tokio::test]
#[serial_test::serial]
async fn finds_a_message_of_another_conversation_with_its_position_and_title() {
    let _db = crate::db::testing::test_db();
    seed(&[
        ("web", AGENT, Some("Staging plans")),
        ("other", "other-agent", None),
    ])
    .await;
    stored("web", "w0", 1, MessageRole::User, "hello", |_| {}).await;
    stored("web", "w1", 2, MessageRole::Agent, "hi", |row| {
        row.is_compacted = true
    })
    .await;
    stored(
        "web",
        "w2",
        3,
        MessageRole::User,
        "The staging codename is TANGERINE.",
        |_| {},
    )
    .await;
    stored(
        "web",
        "sys",
        4,
        MessageRole::System,
        "TANGERINE tools changed",
        |_| {},
    )
    .await;
    stored(
        "other",
        "o1",
        1,
        MessageRole::User,
        "TANGERINE elsewhere",
        |_| {},
    )
    .await;

    let outcome = CONVERSATION_SEARCH_SERVICE
        .search(options("tangerine codename"))
        .await
        .unwrap();

    assert_eq!(ids(&outcome), [("w2".to_string(), 2)]);
    assert_eq!(outcome.matches[0].thread_id, "web");
    assert_eq!(
        outcome.matches[0].conversation_title.as_deref(),
        Some("Staging plans")
    );
    assert!(!outcome.any_word);
}

#[tokio::test]
#[serial_test::serial]
async fn retries_with_any_word_when_no_message_holds_them_all() {
    let _db = crate::db::testing::test_db();
    seed(&[("web", AGENT, None)]).await;
    stored(
        "web",
        "w0",
        1,
        MessageRole::User,
        "deploy the billing service",
        |_| {},
    )
    .await;

    let outcome = CONVERSATION_SEARCH_SERVICE
        .search(options("billing invoices"))
        .await
        .unwrap();
    assert_eq!(ids(&outcome), [("w0".to_string(), 0)]);
    assert!(outcome.any_word);

    let none = CONVERSATION_SEARCH_SERVICE
        .search(options("payroll"))
        .await
        .unwrap();
    assert!(none.matches.is_empty());
    assert!(!none.any_word);
    assert!(
        CONVERSATION_SEARCH_SERVICE
            .search(options("--"))
            .await
            .unwrap()
            .no_words
    );
}

#[tokio::test]
#[serial_test::serial]
async fn reads_a_conversation_by_position_compacted_messages_first() {
    let _db = crate::db::testing::test_db();
    seed(&[("web", AGENT, None)]).await;
    for (i, content) in ["one", "two", "three", "four"].into_iter().enumerate() {
        let compacted = i < 2;
        stored(
            "web",
            &format!("m{i}"),
            i as u32,
            MessageRole::User,
            content,
            move |row| {
                row.is_compacted = compacted;
            },
        )
        .await;
    }
    stored(
        "web",
        "sys",
        9,
        MessageRole::System,
        "tools changed",
        |_| {},
    )
    .await;

    let page = CONVERSATION_SEARCH_SERVICE
        .list_history("web", 1, 2)
        .await
        .unwrap();
    assert_eq!(
        page.messages
            .iter()
            .map(|m| (m.content.as_str(), m.position))
            .collect::<Vec<_>>(),
        [("two", 1), ("three", 2)]
    );
    assert!(page.more);
    let last = CONVERSATION_SEARCH_SERVICE
        .list_history("web", 3, 2)
        .await
        .unwrap();
    assert_eq!(last.messages.len(), 1);
    assert!(!last.more);

    let third = CONVERSATION_SEARCH_SERVICE
        .get_history_message("web", 2)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(third.content, "three");
    assert!(
        CONVERSATION_SEARCH_SERVICE
            .get_history_message("web", 4)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_a_channels_person_messages_and_follows_an_edit() {
    let _db = crate::db::testing::test_db();
    seed(&[("slack", AGENT, None)]).await;
    // Before the copies: the person message that started the turn, as the turn stored it.
    stored(
        "slack",
        "early",
        1,
        MessageRole::User,
        "an early question",
        |_| {},
    )
    .await;
    stored(
        "slack",
        "asked",
        5,
        MessageRole::User,
        "is the rollout done",
        |_| {},
    )
    .await;
    stored(
        "slack",
        "reply",
        6,
        MessageRole::Agent,
        "the rollout is done",
        |_| {},
    )
    .await;

    let read = [
        read_from_channel("4.0", 4, "<@U2:Sam>: a side remark about quotas"),
        read_from_channel("5.0", 5, "<@U1:Dana>: is the rollout done"),
    ];
    CONVERSATION_SEARCH_SERVICE
        .record_channel_messages("slack", &read)
        .await
        .unwrap();
    // A second read with the same messages changes nothing.
    CONVERSATION_SEARCH_SERVICE
        .record_channel_messages("slack", &read)
        .await
        .unwrap();

    let all = CONVERSATION_SEARCH_SERVICE
        .list_history("slack", 0, 20)
        .await
        .unwrap();
    assert_eq!(
        all.messages
            .iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>(),
        [
            "an early question",
            "<@U2:Sam>: a side remark about quotas",
            "<@U1:Dana>: is the rollout done",
            "the rollout is done"
        ]
    );

    let quotas = CONVERSATION_SEARCH_SERVICE
        .search(options("quotas"))
        .await
        .unwrap();
    assert_eq!(quotas.matches[0].message.position, 1);
    assert_eq!(
        quotas.matches[0].message.sender_name.as_deref(),
        Some("Dana")
    );

    let rollout = CONVERSATION_SEARCH_SERVICE
        .search(options("rollout done"))
        .await
        .unwrap();
    let mut positions: Vec<i64> = rollout.matches.iter().map(|m| m.message.position).collect();
    positions.sort();
    assert_eq!(positions, [2, 3]);

    CONVERSATION_SEARCH_SERVICE
        .record_channel_messages(
            "slack",
            &[read_from_channel(
                "5.0",
                5,
                "<@U1:Dana>: is the canary done",
            )],
        )
        .await
        .unwrap();
    let edited = CONVERSATION_SEARCH_SERVICE
        .search(options("canary"))
        .await
        .unwrap();
    assert_eq!(edited.matches.len(), 1);
    assert_eq!(edited.matches[0].message.position, 2);
}

#[tokio::test]
#[serial_test::serial]
async fn the_tool_searches_then_reads_the_current_conversation() {
    let _db = crate::db::testing::test_db();
    seed(&[("web", AGENT, None), ("other", "other-agent", None)]).await;
    stored(
        "web",
        "w0",
        1,
        MessageRole::User,
        "remember the vault path",
        |_| {},
    )
    .await;
    stored("web", "w1", 2, MessageRole::Agent, "Saved it.", |row| {
        row.tool_calls = Some(json!([{
            "tool": "memory_write",
            "input": { "content": "vault path is /srv/vault" },
            "output": "ok"
        }]));
    })
    .await;
    let bound = ConversationSearchToolsInput {
        agent_id: AGENT.into(),
        user_id: "user-1".into(),
        thread_id: Some("web".into()),
        workspace_root: None,
    };

    let found = run_conversation_search(
        ConversationSearchInput {
            query: Some("/srv/vault".into()),
            conversation_id: Some("current".into()),
            ..ConversationSearchInput::default()
        },
        &bound,
        at(30),
    )
    .await
    .unwrap();
    assert_eq!(found["matches"][0]["position"], 1);
    assert_eq!(found["matches"][0]["current"], true);
    assert_eq!(found["matches"][0]["from"], "you");

    let read = run_conversation_search(
        ConversationSearchInput {
            conversation_id: Some("web".into()),
            offset: Some(1),
            ..ConversationSearchInput::default()
        },
        &bound,
        at(30),
    )
    .await
    .unwrap();
    assert_eq!(read["messages"][0]["toolCalls"][0]["output"], "ok");

    let later = run_conversation_search(
        ConversationSearchInput {
            query: Some("vault".into()),
            after: Some("1h".into()),
            ..ConversationSearchInput::default()
        },
        &bound,
        at(30) + chrono::Duration::hours(2),
    )
    .await
    .unwrap();
    assert_eq!(later["note"], "No message matches.");

    for (conversation, note) in [
        ("other", "No conversation has the id other."),
        ("missing", "No conversation has the id missing."),
    ] {
        let refused = run_conversation_search(
            ConversationSearchInput {
                conversation_id: Some(conversation.into()),
                ..ConversationSearchInput::default()
            },
            &bound,
            at(30),
        )
        .await
        .unwrap();
        assert_eq!(refused["note"], note);
    }
}
