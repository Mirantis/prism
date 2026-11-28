//! The full-text index, on a database built from the committed migrations.

use chrono::{DateTime, TimeZone, Utc};
use diesel::prelude::*;
use serde_json::{Value, json};

use super::*;
use crate::db::models::{
    MessageRole, MessageTrigger, NewAgentWorkspace, NewChannelMessage, NewConversationMessage,
    NewConversationThread,
};
use crate::db::schema::{
    agent_workspaces, channel_messages, conversation_messages, conversation_threads,
};
use crate::db::sql_types::DbDateTime;

fn at(minute: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 8, 8, minute, 0).unwrap()
}

fn seed(conn: &mut SqliteConnection, threads: &[&str]) {
    let mut agent = NewAgentWorkspace::new("user-1", "", "", "", "", "");
    agent.id = "agent-1".into();
    diesel::insert_into(agent_workspaces::table)
        .values(&agent)
        .execute(conn)
        .unwrap();
    for id in threads {
        let mut thread = NewConversationThread::new("agent-1", "user-1");
        thread.id = (*id).into();
        diesel::insert_into(conversation_threads::table)
            .values(&thread)
            .execute(conn)
            .unwrap();
    }
}

fn message(
    conn: &mut SqliteConnection,
    thread: &str,
    id: &str,
    minute: u32,
    edit: impl FnOnce(&mut NewConversationMessage),
) {
    let mut row =
        NewConversationMessage::new(thread, MessageRole::User, "", MessageTrigger::UserInput);
    row.id = id.into();
    row.created_at = DbDateTime(at(minute));
    edit(&mut row);
    diesel::insert_into(conversation_messages::table)
        .values(&row)
        .execute(conn)
        .unwrap();
}

fn channel_message(
    conn: &mut SqliteConnection,
    thread: &str,
    ts: &str,
    minute: u32,
    content: &str,
) {
    let row = NewChannelMessage {
        id: format!("c-{ts}"),
        thread_id: thread.into(),
        external_message_id: ts.into(),
        sender_external_id: Some("U1".into()),
        sender_name: Some("Dana".into()),
        content: content.into(),
        created_at: DbDateTime(at(minute)),
        updated_at: DbDateTime(at(minute)),
    };
    diesel::insert_into(channel_messages::table)
        .values(&row)
        .execute(conn)
        .unwrap();
}

fn find(conn: &mut SqliteConnection, words: &str) -> Vec<String> {
    find_with(conn, words, |_| {})
}

fn find_with(
    conn: &mut SqliteConnection,
    words: &str,
    edit: impl FnOnce(&mut IndexQuery),
) -> Vec<String> {
    let mut query = IndexQuery {
        matching: fts_query(words, false).unwrap(),
        agent_id: "agent-1".into(),
        limit: 10,
        ..IndexQuery::default()
    };
    edit(&mut query);
    search(conn, &query)
        .unwrap()
        .into_iter()
        .map(|hit| hit.message_id.or(hit.channel_message_id).unwrap())
        .collect()
}

fn calls(value: Value) -> impl FnOnce(&mut NewConversationMessage) {
    move |row| {
        row.role = MessageRole::Agent;
        row.content = "Checked the pods.".into();
        row.tool_calls = Some(value);
    }
}

#[test]
#[serial_test::serial]
fn indexes_the_content_and_each_tool_name_and_input_but_no_tool_result() {
    let _db = crate::db::testing::test_db();
    crate::db::run_sync(|conn| {
        seed(conn, &["t1"]);
        message(
            conn,
            "t1",
            "m1",
            1,
            calls(json!([{
                "tool": "shell_exec",
                "input": { "command": "kubectl get pods -n staging" },
                "output": "CrashLoopBackOff",
            }])),
        );

        assert_eq!(find(conn, "checked pods"), ["m1"]);
        assert_eq!(find(conn, "shell_exec"), ["m1"]);
        assert_eq!(find(conn, "kubectl staging"), ["m1"]);
        assert!(find(conn, "CrashLoopBackOff").is_empty());
        Ok(())
    })
    .unwrap();
}

#[test]
#[serial_test::serial]
fn leaves_out_system_rows_and_a_tool_list_that_is_not_an_array() {
    let _db = crate::db::testing::test_db();
    crate::db::run_sync(|conn| {
        seed(conn, &["t1"]);
        message(conn, "t1", "s1", 1, |row| {
            row.role = MessageRole::System;
            row.content = "toolChanges shell_exec".into();
        });
        message(conn, "t1", "m1", 2, |row| {
            row.role = MessageRole::Agent;
            row.content = "done".into();
            row.tool_calls = Some(json!({ "tool": "odd" }));
        });

        assert!(find(conn, "toolChanges").is_empty());
        assert!(find(conn, "odd").is_empty());
        assert_eq!(find(conn, "done"), ["m1"]);
        Ok(())
    })
    .unwrap();
}

#[test]
#[serial_test::serial]
fn follows_an_edit_and_forgets_a_deleted_conversation() {
    let _db = crate::db::testing::test_db();
    crate::db::run_sync(|conn| {
        seed(conn, &["t1"]);
        message(conn, "t1", "m1", 1, |row| {
            row.content = "deploy on Friday".into()
        });

        diesel::update(conversation_messages::table.find("m1"))
            .set(conversation_messages::content.eq("deploy on Monday"))
            .execute(conn)?;
        assert!(find(conn, "friday").is_empty());
        assert_eq!(find(conn, "monday"), ["m1"]);

        diesel::delete(conversation_threads::table.find("t1")).execute(conn)?;
        assert!(find(conn, "monday").is_empty());
        let left: i64 = diesel::sql_query(r#"SELECT count(*) AS n FROM "message_search""#)
            .get_result::<Count>(conn)?
            .n;
        assert_eq!(left, 0);
        Ok(())
    })
    .unwrap();
}

#[test]
#[serial_test::serial]
fn indexes_only_the_start_of_a_long_message() {
    let _db = crate::db::testing::test_db();
    crate::db::run_sync(|conn| {
        seed(conn, &["t1"]);
        let content = format!("early {} lateword", "x ".repeat(INDEXED_CHARS as usize));
        message(conn, "t1", "m1", 1, move |row| row.content = content);

        assert_eq!(find(conn, "early"), ["m1"]);
        assert!(find(conn, "lateword").is_empty());
        Ok(())
    })
    .unwrap();
}

#[test]
#[serial_test::serial]
fn a_channel_message_replaces_the_stored_person_messages_from_its_time_on() {
    let _db = crate::db::testing::test_db();
    crate::db::run_sync(|conn| {
        seed(conn, &["t1"]);
        message(conn, "t1", "old", 1, |row| {
            row.content = "rollback plan".into()
        });
        message(conn, "t1", "new", 5, |row| {
            row.content = "rollback plan".into()
        });
        message(conn, "t1", "reply", 6, |row| {
            row.role = MessageRole::Agent;
            row.content = "rollback plan noted".into();
        });
        channel_message(conn, "t1", "5.0", 5, "<@U1:Dana>: rollback plan, edited");

        let mut found = find(conn, "rollback plan");
        found.sort();
        assert_eq!(found, ["c-5.0", "old", "reply"]);

        diesel::update(channel_messages::table.find("c-5.0"))
            .set(channel_messages::content.eq("<@U1:Dana>: canary first"))
            .execute(conn)?;
        assert_eq!(find(conn, "canary"), ["c-5.0"]);
        Ok(())
    })
    .unwrap();
}

#[test]
#[serial_test::serial]
fn ranks_run_messages_after_conversations_with_people() {
    let _db = crate::db::testing::test_db();
    crate::db::run_sync(|conn| {
        seed(conn, &["t1"]);
        message(conn, "t1", "beat", 1, |row| {
            row.role = MessageRole::Agent;
            row.triggered_by = MessageTrigger::Heartbeat;
            row.content = "disk usage disk usage disk usage".into();
        });
        message(conn, "t1", "person", 2, |row| {
            row.content =
                "is the disk usage fine? a long sentence that ranks lower by itself".into();
        });

        assert_eq!(find(conn, "disk usage"), ["person", "beat"]);
        Ok(())
    })
    .unwrap();
}

#[test]
#[serial_test::serial]
fn limits_a_search_to_one_conversation_and_a_time_window() {
    let _db = crate::db::testing::test_db();
    crate::db::run_sync(|conn| {
        seed(conn, &["t1", "t2"]);
        message(conn, "t1", "a", 1, |row| row.content = "quota".into());
        message(conn, "t1", "b", 10, |row| row.content = "quota".into());
        message(conn, "t2", "c", 10, |row| row.content = "quota".into());

        let mut in_t1 = find_with(conn, "quota", |q| q.thread_id = Some("t1".into()));
        in_t1.sort();
        assert_eq!(in_t1, ["a", "b"]);
        let mut window = find_with(conn, "quota", |q| {
            q.after_ms = Some(at(5).timestamp_millis());
            q.before_ms = Some(at(11).timestamp_millis());
        });
        window.sort();
        assert_eq!(window, ["b", "c"]);
        assert_eq!(
            find_with(conn, "quota", |q| q.before_ms =
                Some(at(10).timestamp_millis())),
            ["a"]
        );
        Ok(())
    })
    .unwrap();
}

#[test]
#[serial_test::serial]
fn indexes_at_boot_the_messages_written_before_the_index_existed() {
    let _db = crate::db::testing::test_db();
    crate::db::run_sync(|conn| {
        seed(conn, &["t1"]);
        conn.batch_execute(
            r#"DROP TABLE "message_search";
               DROP TRIGGER "conversation_messages_search_inserted";
               DROP TRIGGER "channel_messages_search_inserted";"#,
        )?;
        message(conn, "t1", "m1", 1, |row| {
            row.content = "before the index".into()
        });
        channel_message(conn, "t1", "2.0", 2, "a channel note before the index");

        ensure(conn)?;
        let mut found = find(conn, "before index");
        found.sort();
        assert_eq!(found, ["c-2.0", "m1"]);

        ensure(conn)?;
        assert_eq!(find(conn, "channel note"), ["c-2.0"]);
        Ok(())
    })
    .unwrap();
}

#[test]
#[serial_test::serial]
fn reads_a_message_whose_time_is_the_columns_text_default() {
    let _db = crate::db::testing::test_db();
    crate::db::run_sync(|conn| {
        seed(conn, &["t1"]);
        conn.batch_execute(
            r#"INSERT INTO "conversation_messages" ("id", "threadId", "role", "content", "triggeredBy", "createdAt")
               VALUES ('m1', 't1', 'USER', 'legacy row', 'USER_INPUT', '2026-10-08 08:03:00');"#,
        )?;

        let hits = search(
            conn,
            &IndexQuery {
                matching: fts_query("legacy", false).unwrap(),
                agent_id: "agent-1".into(),
                limit: 5,
                ..IndexQuery::default()
            },
        )?;
        assert_eq!(hits[0].created_at_ms, at(3).timestamp_millis());
        Ok(())
    })
    .unwrap();
}

#[test]
#[serial_test::serial]
fn excerpts_the_part_of_a_long_message_around_the_match() {
    let _db = crate::db::testing::test_db();
    crate::db::run_sync(|conn| {
        seed(conn, &["t1"]);
        let content = format!(
            "{} the codename is TANGERINE {}",
            "lead ".repeat(200),
            "tail ".repeat(200)
        );
        message(conn, "t1", "m1", 1, move |row| row.content = content);

        let hits = search(
            conn,
            &IndexQuery {
                matching: fts_query("tangerine", false).unwrap(),
                agent_id: "agent-1".into(),
                limit: 5,
                ..IndexQuery::default()
            },
        )?;
        assert!(hits[0].excerpt.contains("codename is TANGERINE"));
        assert!(hits[0].excerpt.len() < 400);
        Ok(())
    })
    .unwrap();
}

#[test]
#[serial_test::serial]
fn writes_each_word_as_literal_text() {
    assert_eq!(
        fts_query("deploy my-app.config \"NEAR\" OR (x*)", false).as_deref(),
        Some(r#""deploy" "my-app.config" "NEAR" "OR" "x""#)
    );
    assert_eq!(
        fts_query("staging region", true).as_deref(),
        Some(r#""staging" OR "region""#)
    );
    assert_eq!(fts_query(" -- ** ", false), None);
    assert_eq!(
        fts_query(&"w ".repeat(40), false)
            .unwrap()
            .matches('"')
            .count(),
        MAX_QUERY_WORDS * 2
    );
}

#[test]
#[serial_test::serial]
fn matches_a_phrase_and_any_word() {
    let _db = crate::db::testing::test_db();
    crate::db::run_sync(|conn| {
        seed(conn, &["t1"]);
        message(conn, "t1", "m1", 1, |row| {
            row.content = "edit my-app.config.ts now".into()
        });
        message(conn, "t1", "m2", 2, |row| {
            row.content = "the region is eu-west-1".into()
        });

        assert_eq!(find(conn, "my-app.config.ts"), ["m1"]);
        assert!(find(conn, "config.my-app").is_empty());
        let any = search(
            conn,
            &IndexQuery {
                matching: fts_query("staging region", true).unwrap(),
                agent_id: "agent-1".into(),
                limit: 5,
                ..IndexQuery::default()
            },
        )?;
        assert_eq!(any.len(), 1);
        assert!(find(conn, "staging region").is_empty());
        Ok(())
    })
    .unwrap();
}

#[test]
#[serial_test::serial]
fn leaves_out_the_context_rows_the_runtime_adds() {
    let _db = crate::db::testing::test_db();
    crate::db::run_sync(|conn| {
        seed(conn, &["t1"]);
        message(conn, "t1", "said", 1, |row| {
            row.content = "the staging cluster codename is TANGERINE-42".into()
        });
        for (i, minute) in (2..7).enumerate() {
            message(conn, "t1", &format!("recalled-{i}"), minute, |row| {
                row.content =
                    "<recalled-memories>staging cluster codename TANGERINE-42</recalled-memories>"
                        .into();
                row.internal_step = true;
            });
        }
        assert_eq!(find(conn, "TANGERINE"), ["said"]);

        // A row that becomes hidden leaves the index.
        diesel::update(conversation_messages::table.find("said"))
            .set(conversation_messages::internal_step.eq(true))
            .execute(conn)?;
        assert!(find(conn, "TANGERINE").is_empty());
        Ok(())
    })
    .unwrap();
}

#[test]
#[serial_test::serial]
fn keeps_the_person_messages_no_channel_read_held() {
    let _db = crate::db::testing::test_db();
    crate::db::run_sync(|conn| {
        seed(conn, &["t1"]);
        message(conn, "t1", "copied", 5, |row| {
            row.content = "rollback plan".into()
        });
        message(conn, "t1", "pressed", 5, |row| {
            row.content = "rollback plan pressed".into();
            row.trigger_name = Some(PRESS_TRIGGER_NAME.into());
        });
        // Sent while a turn ran, after the last read.
        message(conn, "t1", "later", 8, |row| {
            row.content = "rollback plan later".into()
        });
        channel_message(conn, "t1", "5.0", 5, "<@U1:Dana>: rollback plan");

        let mut found = find(conn, "rollback plan");
        found.sort();
        assert_eq!(found, ["c-5.0", "later", "pressed"]);
        Ok(())
    })
    .unwrap();
}

#[test]
#[serial_test::serial]
fn limits_a_search_to_one_channels_conversations_and_the_current_one() {
    let _db = crate::db::testing::test_db();
    crate::db::run_sync(|conn| {
        seed(conn, &["public", "private", "web"]);
        for (thread, channel) in [("public", "C-PUBLIC"), ("private", "C-PRIVATE")] {
            diesel::update(conversation_threads::table.find(thread))
                .set(conversation_threads::external_channel_id.eq(channel))
                .execute(conn)?;
        }
        for thread in ["public", "private", "web"] {
            message(conn, thread, thread, 1, |row| {
                row.content = "the password is hunter2".into()
            });
        }

        let mut everywhere = find(conn, "password");
        everywhere.sort();
        assert_eq!(everywhere, ["private", "public", "web"]);
        assert_eq!(
            find_with(conn, "password", |query| {
                query.channel_id = Some("C-PUBLIC".into());
            }),
            ["public"]
        );
        let mut with_current = find_with(conn, "password", |query| {
            query.channel_id = Some("C-PUBLIC".into());
            query.current_thread_id = Some("web".into());
        });
        with_current.sort();
        assert_eq!(with_current, ["public", "web"]);
        Ok(())
    })
    .unwrap();
}
