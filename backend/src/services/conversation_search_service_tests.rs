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
        scope: SearchScope::All,
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

#[tokio::test]
#[serial_test::serial]
async fn blanks_the_copy_of_a_message_the_channel_no_longer_holds() {
    let _db = crate::db::testing::test_db();
    seed(&[("slack", AGENT, None)]).await;
    let first = [
        read_from_channel("4.0", 4, "<@U1:Dana>: the token is tok-123"),
        read_from_channel("5.0", 5, "<@U1:Dana>: thanks"),
        read_from_channel("6.0", 6, "<@U1:Dana>: one more thing"),
    ];
    CONVERSATION_SEARCH_SERVICE
        .record_channel_messages("slack", &first)
        .await
        .unwrap();
    assert_eq!(
        CONVERSATION_SEARCH_SERVICE
            .search(options("tok-123"))
            .await
            .unwrap()
            .matches
            .len(),
        1
    );

    // A windowed read from 5.0 on leaves 4.0 out, and 4.0 is outside its span.
    CONVERSATION_SEARCH_SERVICE
        .record_channel_messages("slack", &first[1..])
        .await
        .unwrap();
    assert_eq!(
        CONVERSATION_SEARCH_SERVICE
            .search(options("tok-123"))
            .await
            .unwrap()
            .matches
            .len(),
        1
    );
    CONVERSATION_SEARCH_SERVICE
        .record_channel_messages(
            "slack",
            // The person deleted the token and the thanks; this read spans both.
            &[
                read_from_channel("3.0", 3, "<@U1:Dana>: hello"),
                first[2].clone(),
            ],
        )
        .await
        .unwrap();
    assert!(
        CONVERSATION_SEARCH_SERVICE
            .search(options("tok-123"))
            .await
            .unwrap()
            .matches
            .is_empty()
    );
    let all = CONVERSATION_SEARCH_SERVICE
        .list_history("slack", 0, 20)
        .await
        .unwrap();
    assert_eq!(
        all.messages
            .iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>(),
        ["<@U1:Dana>: hello", "<@U1:Dana>: one more thing"]
    );
}

#[tokio::test]
#[serial_test::serial]
async fn numbers_rows_with_the_text_default_time_where_the_read_puts_them() {
    let _db = crate::db::testing::test_db();
    seed(&[("web", AGENT, None)]).await;
    stored(
        "web",
        "written",
        1,
        MessageRole::User,
        "a written row",
        |_| {},
    )
    .await;
    crate::db::run(|conn| {
        use diesel::connection::SimpleConnection;
        conn.batch_execute(
            r#"INSERT INTO "conversation_messages" ("id", "threadId", "role", "content", "triggeredBy", "createdAt") VALUES
               ('legacy-a', 'web', 'USER', 'legacy marker one', 'USER_INPUT', '2026-10-08 07:00:00'),
               ('legacy-b', 'web', 'AGENT', 'legacy marker two', 'USER_INPUT', '2026-10-08 07:30:00');"#,
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let found = CONVERSATION_SEARCH_SERVICE
        .search(options("legacy marker"))
        .await
        .unwrap();
    let mut positions = ids(&found);
    positions.sort();
    assert_eq!(
        positions,
        [("legacy-a".to_string(), 1), ("legacy-b".to_string(), 2)]
    );
    for (id, position) in positions {
        let read = CONVERSATION_SEARCH_SERVICE
            .get_history_message("web", position)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(read.id, id);
    }
}

#[tokio::test]
#[serial_test::serial]
async fn a_search_of_one_conversation_also_matches_its_tool_results() {
    let _db = crate::db::testing::test_db();
    seed(&[("web", AGENT, None)]).await;
    stored("web", "ask", 1, MessageRole::User, "deploy it", |_| {}).await;
    stored("web", "deploy", 2, MessageRole::Agent, "Deployed.", |row| {
        row.tool_calls = Some(json!([{
            "tool": "shell_exec",
            "input": { "command": "./deploy.sh" },
            "output": "uploading...\nbuild id: bld-7f3a9c2e\ndone"
        }]));
    })
    .await;

    let everywhere = CONVERSATION_SEARCH_SERVICE
        .search(options("bld-7f3a9c2e"))
        .await
        .unwrap();
    assert!(everywhere.matches.is_empty());

    let mut in_one = options("Build ID");
    in_one.thread_id = Some("web".into());
    let found = CONVERSATION_SEARCH_SERVICE.search(in_one).await.unwrap();
    assert_eq!(ids(&found), [("deploy".to_string(), 1)]);
    assert!(found.matches[0].excerpt.starts_with("[tool result] "));
    assert!(found.matches[0].excerpt.contains("bld-7f3a9c2e"));

    let mut any = options("build nightly");
    any.thread_id = Some("web".into());
    let found = CONVERSATION_SEARCH_SERVICE.search(any).await.unwrap();
    assert!(found.any_word);
    assert_eq!(ids(&found), [("deploy".to_string(), 1)]);
}

#[tokio::test]
#[serial_test::serial]
async fn a_tool_result_search_reads_past_a_page_of_near_misses_within_its_time_bounds() {
    let _db = crate::db::testing::test_db();
    seed(&[("web", AGENT, None)]).await;
    stored("web", "old", 1, MessageRole::Agent, "Rotated.", |row| {
        row.tool_calls = Some(json!([{
            "tool": "shell_exec",
            "input": { "command": "./rotate.sh" },
            "output": "kubectl: secret rotated"
        }]));
    })
    .await;
    // Newer rows hold both words in their stored JSON, but not both in a result,
    // so the first pass takes them and the match turns each away.
    for i in 0..(OUTPUT_PAGE + 10) {
        stored(
            "web",
            &format!("near-{i}"),
            2,
            MessageRole::Agent,
            "Applied.",
            move |row| {
                row.created_at = DbDateTime(at(2) + chrono::Duration::seconds(i));
                row.tool_calls = Some(json!([{
                    "tool": "shell_exec",
                    "input": { "command": "kubectl apply -f cm.yaml" },
                    "output": "configmap rotated"
                }]));
            },
        )
        .await;
    }

    let mut search = options("kubectl rotated");
    search.thread_id = Some("web".into());
    let found = CONVERSATION_SEARCH_SERVICE
        .search(search.clone())
        .await
        .unwrap();
    assert!(!found.any_word);
    assert_eq!(found.matches.len(), 1);
    assert_eq!(found.matches[0].message.id, "old");

    search.before_ms = Some(at(2).timestamp_millis());
    let found = CONVERSATION_SEARCH_SERVICE
        .search(search.clone())
        .await
        .unwrap();
    assert_eq!(ids(&found), [("old".to_string(), 0)]);

    search.after_ms = Some(at(2).timestamp_millis());
    search.before_ms = None;
    let found = CONVERSATION_SEARCH_SERVICE.search(search).await.unwrap();
    assert!(found.matches.iter().all(|hit| hit.message.id != "old"));
}

#[tokio::test]
#[serial_test::serial]
async fn a_run_reaches_only_the_conversations_its_scope_allows() {
    let _db = crate::db::testing::test_db();
    seed(&[
        ("public", AGENT, None),
        ("private", AGENT, None),
        ("web", AGENT, None),
    ])
    .await;
    crate::db::run(|conn| {
        for (thread, channel) in [("public", "C-PUBLIC"), ("private", "C-PRIVATE")] {
            diesel::update(conversation_threads::table.find(thread))
                .set(conversation_threads::external_channel_id.eq(channel))
                .execute(conn)?;
        }
        Ok(())
    })
    .await
    .unwrap();
    for thread in ["public", "private", "web"] {
        stored(
            thread,
            thread,
            1,
            MessageRole::User,
            "the password is hunter2",
            |_| {},
        )
        .await;
    }
    let search = |scope: SearchScope, current: &str, conversation: Option<&str>| {
        let bound = ConversationSearchToolsInput {
            agent_id: AGENT.into(),
            user_id: "user-1".into(),
            thread_id: Some(current.into()),
            workspace_root: None,
            scope,
        };
        let input = ConversationSearchInput {
            query: Some("password".into()),
            conversation_id: conversation.map(str::to_string),
            max_results: Some(10),
            ..ConversationSearchInput::default()
        };
        async move {
            run_conversation_search(input, &bound, at(30))
                .await
                .unwrap()
        }
    };
    let found = |result: &Value| -> Vec<String> {
        let mut ids: Vec<String> = result["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["conversationId"].as_str().unwrap().to_string())
            .collect();
        ids.sort();
        ids
    };

    let channel = SearchScope::Channel("C-PUBLIC".into());
    assert_eq!(
        found(&search(channel.clone(), "public", None).await),
        ["public"]
    );
    assert_eq!(
        search(channel.clone(), "public", Some("private")).await["note"],
        "No conversation has the id private."
    );
    assert_eq!(
        search(SearchScope::Current, "web", None).await["matches"][0]["conversationId"],
        "web"
    );
    assert_eq!(
        search(SearchScope::Current, "web", Some("public")).await["note"],
        "No conversation has the id public."
    );
    assert_eq!(
        found(&search(SearchScope::All, "web", None).await),
        ["private", "public", "web"]
    );
}
