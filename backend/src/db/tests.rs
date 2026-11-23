//! The schema, the column encodings and the committed migrations, against real
//! database files.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use chrono::{DateTime, TimeZone, Utc};
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_types::{BigInt, Text};
use diesel::sqlite::Sqlite;
use serde_json::json;

use super::models::*;
use super::schema::*;
use super::sql_types::{parse_db_datetime, uint8_array};
use super::{Database, MIGRATIONS, migrate};
use crate::lib::sqlite_path::SCHEMA_DIR;
use crate::lib::workspace_docs::WORKSPACE_DOC_FIELDS;
use crate::sea::migrate::{Migration, apply_migrations};

#[derive(QueryableByName, Debug)]
struct One {
    #[diesel(sql_type = Text)]
    value: String,
}

#[derive(QueryableByName, Debug)]
struct Count {
    #[diesel(sql_type = BigInt)]
    n: i64,
}

fn text(conn: &mut SqliteConnection, sql: &str) -> String {
    diesel::sql_query(sql)
        .get_result::<One>(conn)
        .unwrap()
        .value
}

fn texts(conn: &mut SqliteConnection, sql: &str) -> Vec<String> {
    diesel::sql_query(sql)
        .load::<One>(conn)
        .unwrap()
        .into_iter()
        .map(|r| r.value)
        .collect()
}

fn count(conn: &mut SqliteConnection, sql: &str) -> i64 {
    diesel::sql_query(sql).get_result::<Count>(conn).unwrap().n
}

fn ms(ms: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms).unwrap()
}

fn insert_agent(conn: &mut SqliteConnection, id: &str) -> anyhow::Result<()> {
    let mut agent =
        NewAgentWorkspace::new("user-1", "soul", "user", "memory", "heartbeat", "bootstrap");
    agent.id = id.to_string();
    diesel::insert_into(agent_workspaces::table)
        .values(&agent)
        .execute(conn)?;
    Ok(())
}

fn temp_file() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("agent.db");
    (dir, file)
}

// ---------------------------------------------------------------- migrations

#[test]
fn embeds_every_committed_migration_in_name_order() {
    let dir = SCHEMA_DIR.join("migrations");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().join("migration.sql").is_file())
        .map(|e| e.file_name().into_string().unwrap())
        .collect();
    names.sort();
    let embedded: Vec<&str> = MIGRATIONS.iter().map(|m| m.name).collect();
    assert_eq!(embedded, names);
    for migration in MIGRATIONS {
        let on_disk =
            std::fs::read_to_string(dir.join(migration.name).join("migration.sql")).unwrap();
        assert_eq!(migration.sql, on_disk, "{}", migration.name);
    }
}

#[test]
fn loads_every_model_from_the_migrated_schema_and_models_every_column() {
    let mut conn = super::open_connection(":memory:").unwrap();
    migrate(&mut conn).unwrap();

    macro_rules! check {
        ($($table:ident => $model:ty),+ $(,)?) => {{
            let mut modeled = Vec::new();
            $(
                let query = $table::table.select(<$model>::as_select());
                let rows: Vec<$model> = query.load(&mut conn).unwrap();
                assert!(rows.is_empty());
                let sql = diesel::debug_query::<Sqlite, _>(&query).to_string();
                let selected = sql.matches(concat!("`", stringify!($table), "`.`")).count() as i64;
                let stored = count(&mut conn, &format!("SELECT count(*) AS n FROM pragma_table_info('{}')", stringify!($table)));
                assert_eq!(selected, stored, "columns of {}", stringify!($table));
                modeled.push(stringify!($table).to_string());
            )+
            modeled
        }};
    }
    let mut modeled = check!(
        agent_workspaces => AgentWorkspace,
        agent_workspace_revisions => AgentWorkspaceRevision,
        conversation_threads => ConversationThread,
        conversation_messages => ConversationMessage,
        message_attachments => MessageAttachment,
        conversation_participants => ConversationParticipant,
        cron_tasks => CronTask,
        goals => Goal,
        llm_calls => LlmCall,
        memory_entries => MemoryEntry,
        slack_mappings => SlackMapping,
        slack_verification_codes => SlackVerificationCode,
        teams_mappings => TeamsMapping,
        teams_verification_codes => TeamsVerificationCode,
        agent_subagents => AgentSubagent,
        slack_heartbeat_triggers => SlackHeartbeatTrigger,
        pending_slack_messages => PendingSlackMessage,
        webhook_subscriptions => WebhookSubscription,
        webhook_runs => WebhookRun,
        remote_computers => RemoteComputer,
        update_attempts => UpdateAttempt,
        runtime_state => RuntimeState,
        pending_work => PendingWork,
    );
    modeled.sort();
    let stored = texts(
        &mut conn,
        "SELECT name AS value FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' ORDER BY name",
    );
    assert_eq!(modeled, stored);
}

#[test]
fn keeps_referencing_rows_when_a_migration_rebuilds_a_table() {
    // This migration rebuilds `agent_workspaces`, which every other table references.
    let cut = MIGRATIONS
        .iter()
        .position(|m| m.name == "20260623130000_drop_proactivity_verbosity")
        .unwrap();
    let mut conn = super::open_connection(":memory:").unwrap();
    apply_migrations(&mut conn, &MIGRATIONS[..cut]).unwrap();
    conn.batch_execute(
        r#"INSERT INTO "agent_workspaces" ("id", "userId", "soulMd", "userMd", "memoryMd", "heartbeatMd", "bootstrapMd", "updatedAt")
             VALUES ('agent-1', 'user-1', '', '', '', '', '', 1);
           INSERT INTO "memory_entries" ("id", "agentId", "content", "category") VALUES ('m1', 'agent-1', 'kept', 'fact');"#,
    )
    .unwrap();

    apply_migrations(&mut conn, MIGRATIONS).unwrap();

    assert_eq!(
        count(&mut conn, r#"SELECT count(*) AS n FROM "memory_entries""#),
        1
    );
    assert_eq!(
        count(
            &mut conn,
            "SELECT foreign_keys AS n FROM pragma_foreign_keys"
        ),
        1
    );
}

const SPEND_MIGRATION: &str = "20261121155112_llm_call_spend";

#[derive(QueryableByName, Debug, PartialEq)]
struct SpendRow {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = BigInt)]
    created_at: i64,
    #[diesel(sql_type = Text)]
    kind: String,
    #[diesel(sql_type = BigInt)]
    bucket: i64,
}

/// The runtime writes `createdAt` as epoch milliseconds, but a row that took the
/// column's `CURRENT_TIMESTAMP` default holds text. Both must come out of the
/// upgrade as epoch milliseconds with a matching 15-minute bucket, or range and
/// period queries miss them.
#[test]
fn the_spend_migration_stores_text_and_integer_timestamps_as_epoch_milliseconds_with_their_bucket()
{
    let cut = MIGRATIONS
        .iter()
        .position(|m| m.name == SPEND_MIGRATION)
        .unwrap();
    assert!(cut > 0);
    let mut conn = super::open_connection(":memory:").unwrap();
    apply_migrations(&mut conn, &MIGRATIONS[..cut]).unwrap();
    insert_legacy_agent(&mut conn, "agent-1");
    let written = Utc
        .with_ymd_and_hms(2026, 11, 20, 10, 7, 30)
        .unwrap()
        .timestamp_millis()
        + 250;
    diesel::sql_query(
        r#"INSERT INTO "llm_calls" ("id", "agentId", "purpose", "model", "createdAt") VALUES ('integer', 'agent-1', 'chat', 'm', ?)"#,
    )
    .bind::<BigInt, _>(written)
    .execute(&mut conn)
    .unwrap();
    // What SQLite's CURRENT_TIMESTAMP default writes.
    conn.batch_execute(
        r#"INSERT INTO "llm_calls" ("id", "agentId", "purpose", "model") VALUES ('default', 'agent-1', 'chat', 'm');
           UPDATE "llm_calls" SET "createdAt" = '2026-11-20 10:22:05' WHERE "id" = 'default';"#,
    )
    .unwrap();

    apply_migrations(&mut conn, MIGRATIONS).unwrap();

    let rows: Vec<SpendRow> = diesel::sql_query(
        r#"SELECT "id", "createdAt" AS "created_at", typeof("createdAt") AS "kind", "bucket" FROM "llm_calls" ORDER BY "id""#,
    )
    .load(&mut conn)
    .unwrap();
    let at = |h, m, s| {
        Utc.with_ymd_and_hms(2026, 11, 20, h, m, s)
            .unwrap()
            .timestamp_millis()
    };
    assert_eq!(
        rows,
        vec![
            SpendRow {
                id: "default".into(),
                created_at: at(10, 22, 5),
                kind: "integer".into(),
                bucket: at(10, 15, 0),
            },
            SpendRow {
                id: "integer".into(),
                created_at: written,
                kind: "integer".into(),
                bucket: at(10, 0, 0),
            },
        ]
    );
}

const REVISIONS_MIGRATION: &str = "20260905120000_add_agent_workspace_revisions";
const UPGRADE_REASON: &str = "Recorded on upgrade. Earlier revisions were not kept.";

/// A database at the migration before the revisions table was added.
fn database_before_revisions() -> (SqliteConnection, &'static Migration<'static>) {
    let cut = MIGRATIONS
        .iter()
        .position(|m| m.name == REVISIONS_MIGRATION)
        .unwrap();
    assert!(cut > 0);
    let mut conn = super::open_connection(":memory:").unwrap();
    apply_migrations(&mut conn, &MIGRATIONS[..cut]).unwrap();
    (conn, &MIGRATIONS[cut])
}

/// One agent row, as an install upgrading from that build holds it.
fn insert_legacy_agent(conn: &mut SqliteConnection, id: &str) -> Vec<(String, String)> {
    let documents: Vec<(String, String)> = WORKSPACE_DOC_FIELDS
        .iter()
        .map(|f| (f.as_str().to_string(), format!("# {} of {id}", f.as_str())))
        .collect();
    let mut columns = vec!["id".to_string(), "userId".to_string()];
    columns.extend(documents.iter().map(|(field, _)| field.clone()));
    columns.push("updatedAt".to_string());
    let sql = format!(
        r#"INSERT INTO "agent_workspaces" ({}) VALUES ({})"#,
        columns
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", "),
        columns.iter().map(|_| "?").collect::<Vec<_>>().join(", "),
    );
    let mut query = diesel::sql_query(sql).into_boxed::<Sqlite>();
    query = query
        .bind::<Text, _>(id.to_string())
        .bind::<Text, _>("user-1");
    for (_, content) in &documents {
        query = query.bind::<Text, _>(content.clone());
    }
    query
        .bind::<BigInt, _>(crate::support::now_ms())
        .execute(conn)
        .unwrap();
    documents
}

#[derive(QueryableByName, Debug)]
struct RevisionRow {
    #[diesel(sql_type = Text)]
    field: String,
    #[diesel(sql_type = Text)]
    content: String,
    #[diesel(sql_type = Text)]
    actor: String,
    #[diesel(sql_type = Text)]
    method: String,
    #[diesel(sql_type = Text)]
    reason: String,
}

fn revisions_of(conn: &mut SqliteConnection, agent_id: &str) -> Vec<RevisionRow> {
    diesel::sql_query(
        r#"SELECT "field", "content", "actor", "method", "reason"
             FROM "agent_workspace_revisions" WHERE "agentId" = ? ORDER BY "field""#,
    )
    .bind::<Text, _>(agent_id)
    .load(conn)
    .unwrap()
}

#[test]
fn the_revisions_migration_records_a_baseline_for_every_document_of_an_existing_agent() {
    let (mut conn, revisions_migration) = database_before_revisions();
    let documents = insert_legacy_agent(&mut conn, "agent-1");

    apply_migrations(&mut conn, MIGRATIONS).unwrap();

    let rows = revisions_of(&mut conn, "agent-1");
    let mut expected: Vec<&str> = WORKSPACE_DOC_FIELDS.iter().map(|f| f.as_str()).collect();
    expected.sort();
    assert_eq!(
        rows.iter().map(|r| r.field.as_str()).collect::<Vec<_>>(),
        expected
    );
    for row in &rows {
        let content = &documents
            .iter()
            .find(|(field, _)| *field == row.field)
            .unwrap()
            .1;
        assert_eq!(&row.content, content);
        assert_eq!(row.actor, "user");
        assert_eq!(row.method, "seed");
        assert_eq!(row.reason, UPGRADE_REASON);
    }
    assert!(revisions_migration.sql.contains("INSERT OR IGNORE"));
}

#[test]
fn the_revisions_migration_records_a_baseline_per_agent() {
    let (mut conn, _) = database_before_revisions();
    insert_legacy_agent(&mut conn, "agent-1");
    insert_legacy_agent(&mut conn, "agent-2");

    apply_migrations(&mut conn, MIGRATIONS).unwrap();

    assert_eq!(
        revisions_of(&mut conn, "agent-1").len(),
        WORKSPACE_DOC_FIELDS.len()
    );
    assert_eq!(
        revisions_of(&mut conn, "agent-2").len(),
        WORKSPACE_DOC_FIELDS.len()
    );
}

#[test]
fn the_revisions_migration_records_nothing_on_a_fresh_install() {
    let mut conn = super::open_connection(":memory:").unwrap();
    apply_migrations(&mut conn, MIGRATIONS).unwrap();
    assert_eq!(
        count(
            &mut conn,
            r#"SELECT COUNT(*) AS n FROM "agent_workspace_revisions""#
        ),
        0
    );
}

#[test]
fn the_revisions_migration_adds_nothing_when_the_same_list_runs_again() {
    let (mut conn, _) = database_before_revisions();
    insert_legacy_agent(&mut conn, "agent-1");

    apply_migrations(&mut conn, MIGRATIONS).unwrap();
    // Second run: already recorded by name, so the seed does not run twice.
    assert!(apply_migrations(&mut conn, MIGRATIONS).unwrap().is_empty());

    assert_eq!(
        revisions_of(&mut conn, "agent-1").len(),
        WORKSPACE_DOC_FIELDS.len()
    );
}

// ---------------------------------------------------------------- column encodings

#[test]
#[serial_test::serial]
fn round_trips_every_column_encoding_as_the_prisma_adapter_stores_it() {
    let test = super::testing::test_db();
    let created = ms(1_793_976_824_451);
    let tool_calls =
        json!([{ "tool": "shell", "input": { "b": 1, "a": [true, null, 2.5] }, "success": true }]);
    let bytes = vec![0_u8, 1, 2, 255];

    let (agent, message, attachment) = test
        .db
        .run_sync(|conn| {
            let mut agent = NewAgentWorkspace::new(
                "user-1",
                "soul",
                "user",
                "memory",
                "heartbeat",
                "bootstrap",
            );
            agent.id = "agent-1".into();
            agent.model_mode = Some(AgentModelMode::Auto);
            agent.verbose = true;
            agent.next_heartbeat_at = Some(created);
            agent.created_at = created.into();
            agent.updated_at = created.into();
            diesel::insert_into(agent_workspaces::table)
                .values(&agent)
                .execute(conn)?;

            let mut thread = NewConversationThread::new("agent-1", "user-1");
            thread.id = "thread-1".into();
            diesel::insert_into(conversation_threads::table)
                .values(&thread)
                .execute(conn)?;

            let mut message = NewConversationMessage::new(
                "thread-1",
                MessageRole::User,
                "hi",
                MessageTrigger::UserInput,
            );
            message.id = "message-1".into();
            message.tool_calls = Some(tool_calls.clone());
            message.created_at = created.into();
            diesel::insert_into(conversation_messages::table)
                .values(&message)
                .execute(conn)?;

            let mut attachment =
                NewMessageAttachment::new("a.bin", "application/octet-stream", 4, "file", "web");
            attachment.message_id = Some("message-1".into());
            attachment.data = Some(bytes.clone());
            diesel::insert_into(message_attachments::table)
                .values(&attachment)
                .execute(conn)?;

            Ok((
                agent_workspaces::table
                    .select(AgentWorkspace::as_select())
                    .first(conn)?,
                conversation_messages::table
                    .select(ConversationMessage::as_select())
                    .first(conn)?,
                message_attachments::table
                    .select(MessageAttachment::as_select())
                    .first(conn)?,
            ))
        })
        .unwrap();
    let (agent, message, attachment): (AgentWorkspace, ConversationMessage, MessageAttachment) =
        (agent, message, attachment);

    assert_eq!(agent.model_mode, Some(AgentModelMode::Auto));
    assert_eq!(agent.agent_type, AgentType::Agent);
    assert_eq!(agent.heartbeat_status, AgentHeartbeatStatus::Enabled);
    assert_eq!(agent.status, AgentStatus::Idle);
    assert_eq!(agent.heartbeat_interval_ms, 28_800_000);
    assert_eq!(agent.name, "Prism Agent");
    assert!(agent.verbose);
    assert!(!agent.locked_in);
    assert_eq!(agent.next_heartbeat_at, Some(created));
    assert_eq!(agent.last_heartbeat, None);
    assert_eq!(agent.created_at, created);
    assert_eq!(message.tool_calls, Some(tool_calls.clone()));
    assert_eq!(message.blocks, None);
    assert_eq!(message.role, MessageRole::User);
    assert_eq!(attachment.data, Some(bytes));

    #[derive(QueryableByName, Debug)]
    struct Stored {
        #[diesel(sql_type = Text)]
        created_type: String,
        #[diesel(sql_type = BigInt)]
        created_ms: i64,
        #[diesel(sql_type = Text)]
        tool_calls_type: String,
        #[diesel(sql_type = Text)]
        tool_calls: String,
        #[diesel(sql_type = Text)]
        compacted_type: String,
        #[diesel(sql_type = Text)]
        role: String,
    }
    let stored = test
        .db
        .read_sync(|conn| {
            Ok(diesel::sql_query(
                r#"SELECT typeof("createdAt") AS created_type, "createdAt" AS created_ms,
                          typeof("toolCalls") AS tool_calls_type, "toolCalls" AS tool_calls,
                          typeof("isCompacted") AS compacted_type, "role" AS role
                     FROM "conversation_messages""#,
            )
            .get_result::<Stored>(conn)?)
        })
        .unwrap();
    assert_eq!(stored.created_type, "integer");
    assert_eq!(stored.created_ms, 1_793_976_824_451);
    assert_eq!(stored.tool_calls_type, "text");
    assert_eq!(
        stored.tool_calls,
        r#"[{"tool":"shell","input":{"b":1,"a":[true,null,2.5]},"success":true}]"#
    );
    assert_eq!(stored.compacted_type, "integer");
    assert_eq!(stored.role, "USER");
    let blob_type = test
        .db
        .read_sync(|conn| {
            Ok(text(
                conn,
                r#"SELECT typeof("data") AS value FROM "message_attachments""#,
            ))
        })
        .unwrap();
    assert_eq!(blob_type, "blob");
}

#[test]
#[serial_test::serial]
fn reads_dates_stored_as_text() {
    let test = super::testing::test_db();
    let dates = test
        .db
        .run_sync(|conn| {
            insert_agent(conn, "agent-1")?;
            // A row whose `createdAt` comes from the column default, as a migration's
            // INSERT writes it.
            conn.batch_execute(
                r#"INSERT INTO "pending_slack_messages" ("id", "agentId", "sender", "text", "timestamp")
                     VALUES ('p1', 'agent-1', 'U1', 'a', '1')"#,
            )?;
            let from_default: DateTime<Utc> =
                pending_slack_messages::table.select(pending_slack_messages::created_at).first(conn)?;
            let mut read = vec![from_default];
            for stored in ["2026-09-05 12:00:00", "2026-09-05T12:00:00.123+02:00", "2026-09-05", "2026-09-05 12:00:00.5"] {
                diesel::sql_query(r#"UPDATE "pending_slack_messages" SET "createdAt" = ?"#)
                    .bind::<Text, _>(stored)
                    .execute(conn)?;
                read.push(pending_slack_messages::table.select(pending_slack_messages::created_at).first(conn)?);
            }
            Ok(read)
        })
        .unwrap();
    assert!(
        (Utc::now() - dates[0]).num_seconds().abs() < 60,
        "{}",
        dates[0]
    );
    assert_eq!(crate::support::iso(&dates[1]), "2026-09-05T12:00:00.000Z");
    assert_eq!(crate::support::iso(&dates[2]), "2026-09-05T10:00:00.123Z");
    assert_eq!(crate::support::iso(&dates[3]), "2026-09-05T00:00:00.000Z");
    assert_eq!(crate::support::iso(&dates[4]), "2026-09-05T12:00:00.500Z");
}

#[test]
fn parses_date_text_as_the_prisma_client_does() {
    let iso = |text: &str| parse_db_datetime(text).map(|d| crate::support::iso(&d));
    assert_eq!(
        iso("2026-09-05 12:00:00").as_deref(),
        Some("2026-09-05T12:00:00.000Z")
    );
    assert_eq!(
        iso("2026-09-05T12:00:00Z").as_deref(),
        Some("2026-09-05T12:00:00.000Z")
    );
    assert_eq!(
        iso("2026-09-05T12:00:00.123456Z").as_deref(),
        Some("2026-09-05T12:00:00.123Z")
    );
    assert_eq!(
        iso("2026-09-05T12:00:00.000+00:00").as_deref(),
        Some("2026-09-05T12:00:00.000Z")
    );
    assert_eq!(
        iso("2026-09-05 12:00:00+02").as_deref(),
        Some("2026-09-05T10:00:00.000Z")
    );
    assert_eq!(
        iso("2026-09-05").as_deref(),
        Some("2026-09-05T00:00:00.000Z")
    );
    assert_eq!(iso("12:30:00").as_deref(), Some("1970-01-01T12:30:00.000Z"));
    assert_eq!(iso("not a date"), None);
}

#[test]
#[serial_test::serial]
fn refuses_an_enum_value_the_schema_does_not_declare() {
    let test = super::testing::test_db();
    let err = test
        .db
        .run_sync(|conn| {
            insert_agent(conn, "agent-1")?;
            let thread = NewConversationThread::new("agent-1", "user-1");
            let thread_id = thread.id.clone();
            diesel::insert_into(conversation_threads::table)
                .values(&thread)
                .execute(conn)?;
            let message = NewConversationMessage::new(
                thread_id,
                MessageRole::Agent,
                "x",
                MessageTrigger::System,
            );
            diesel::insert_into(conversation_messages::table)
                .values(&message)
                .execute(conn)?;
            conn.batch_execute(r#"UPDATE "conversation_messages" SET "role" = 'BOGUS'"#)?;
            Ok(conversation_messages::table
                .select(ConversationMessage::as_select())
                .first(conn)?)
        })
        .unwrap_err();
    assert!(
        format!("{err:#}").contains("Value 'BOGUS' not found in enum 'MessageRole'"),
        "{err:#}"
    );
}

#[test]
fn enums_keep_the_stored_text() {
    assert_eq!(MessageTrigger::AgentMessage.as_str(), "AGENT_MESSAGE");
    assert_eq!(
        MessageTrigger::TaskNotification.as_str(),
        "TASK_NOTIFICATION"
    );
    assert_eq!(
        "CRON_TASK".parse::<MessageTrigger>().unwrap(),
        MessageTrigger::CronTask
    );
    assert_eq!(WebhookAuthType::None.as_str(), "none");
    assert_eq!(
        serde_json::to_string(&WebhookAuthAlgorithm::Sha512).unwrap(),
        r#""sha512""#
    );
    assert_eq!(
        serde_json::from_str::<UpdateOutcome>(r#""FAILURE""#).unwrap(),
        UpdateOutcome::Failure
    );
    assert_eq!(
        "nope".parse::<ThreadSource>().unwrap_err().to_string(),
        "Value 'nope' not found in enum 'ThreadSource'"
    );
    assert_eq!(
        MessageRole::ALL,
        &[MessageRole::User, MessageRole::Agent, MessageRole::System]
    );
}

#[test]
fn serializes_a_row_as_json_stringify_writes_the_prisma_row() {
    let message = ConversationMessage {
        id: "m1".into(),
        thread_id: "t1".into(),
        role: MessageRole::Agent,
        content: "hello".into(),
        triggered_by: MessageTrigger::Heartbeat,
        trigger_name: None,
        tool_calls: Some(json!([{ "tool": "x" }])),
        blocks: None,
        sender_external_id: None,
        sender_name: Some("Prism".into()),
        external_message_id: None,
        is_compacted: false,
        internal_step: true,
        created_at: ms(1_793_976_824_451),
    };
    assert_eq!(
        serde_json::to_string(&message).unwrap(),
        r#"{"id":"m1","threadId":"t1","role":"AGENT","content":"hello","triggeredBy":"HEARTBEAT","triggerName":null,"toolCalls":[{"tool":"x"}],"blocks":null,"senderExternalId":null,"senderName":"Prism","externalMessageId":null,"isCompacted":false,"internalStep":true,"createdAt":"2026-11-06T14:53:44.451Z"}"#
    );
    let back: ConversationMessage =
        serde_json::from_str(&serde_json::to_string(&message).unwrap()).unwrap();
    assert_eq!(back, message);

    let trigger = SlackHeartbeatTrigger {
        id: "h1".into(),
        connection_id: "c".into(),
        slack_channel_id: "C1".into(),
        slack_channel_name: None,
        agent_id: "a".into(),
        user_id: "u".into(),
        is_active: true,
        throttle_seconds: 60,
        last_triggered_at: None,
        created_at: ms(0),
        updated_at: ms(1),
    };
    let value = serde_json::to_value(&trigger).unwrap();
    assert_eq!(value["throttleSeconds"], json!(60));
    assert_eq!(value["lastTriggeredAt"], json!(null));
    assert_eq!(value["updatedAt"], json!("1970-01-01T00:00:00.001Z"));

    let code = SlackVerificationCode {
        id: "v".into(),
        code: "abc".into(),
        r#type: SlackVerificationType::Dm,
        lens_user_id: "l".into(),
        connection_id: "c".into(),
        agent_id: "a".into(),
        agent_name: None,
        expires_at: ms(0),
        created_at: ms(0),
    };
    assert_eq!(serde_json::to_value(&code).unwrap()["type"], json!("DM"));
}

#[test]
fn serializes_bytes_as_json_stringify_writes_a_uint8_array() {
    #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
    struct Holder {
        #[serde(with = "uint8_array::option")]
        data: Option<Vec<u8>>,
    }
    let holder = Holder {
        data: Some(vec![7, 0, 255]),
    };
    let text = serde_json::to_string(&holder).unwrap();
    assert_eq!(text, r#"{"data":{"0":7,"1":0,"2":255}}"#);
    assert_eq!(serde_json::from_str::<Holder>(&text).unwrap(), holder);
    assert_eq!(
        serde_json::from_str::<Holder>(r#"{"data":[1,2]}"#)
            .unwrap()
            .data,
        Some(vec![1, 2])
    );
    assert_eq!(
        serde_json::to_string(&Holder { data: None }).unwrap(),
        r#"{"data":null}"#
    );
}

#[test]
#[serial_test::serial]
fn a_changeset_stamps_updated_at_and_writes_null_for_some_none() {
    let test = super::testing::test_db();
    let (before, after) = test
        .db
        .run_sync(|conn| {
            let mut task = NewCronTask::new("agent-0", "user-1", "daily", "0 9 * * *", "report");
            insert_agent(conn, "agent-0")?;
            task.updated_at = ms(1_000).into();
            task.channel_ids = Some("C1".into());
            diesel::insert_into(cron_tasks::table)
                .values(&task)
                .execute(conn)?;
            let before: CronTask = cron_tasks::table
                .find(&task.id)
                .select(CronTask::as_select())
                .first(conn)?;
            diesel::update(cron_tasks::table.find(&task.id))
                .set(&CronTaskChangeset {
                    is_active: Some(false),
                    channel_ids: Some(None),
                    ..Default::default()
                })
                .execute(conn)?;
            let after: CronTask = cron_tasks::table
                .find(&task.id)
                .select(CronTask::as_select())
                .first(conn)?;
            Ok((before, after))
        })
        .unwrap();
    assert!(before.is_active);
    assert!(!after.is_active);
    assert_eq!(before.channel_ids.as_deref(), Some("C1"));
    assert_eq!(after.channel_ids, None);
    assert_eq!(after.deliver_to, "all");
    assert!(after.updated_at > before.updated_at);
}

#[test]
fn new_rows_get_a_v4_uuid_and_the_schema_defaults() {
    let row = NewWebhookSubscription::new("agent-1", "github");
    assert_eq!(uuid::Uuid::parse_str(&row.id).unwrap().get_version_num(), 4);
    assert_eq!(row.deliver_to, "all");
    assert_eq!(row.auth_type, WebhookAuthType::Token);
    assert_eq!(row.auth_algorithm, WebhookAuthAlgorithm::Sha256);
    assert_eq!(row.auth_encoding, WebhookAuthEncoding::Hex);
    assert!(row.is_active);
    assert!(!row.deliver_only);
    assert_eq!(row.created_at, row.updated_at);
    let attempt = NewUpdateAttempt::new("v1", "v2", UpdateTrigger::Manual);
    assert_eq!(attempt.outcome, UpdateOutcome::Pending);
    let work = NewPendingWork::new("chat", "k", json!({ "a": 1 }));
    assert_eq!(work.attempts, 0);
}

// ---------------------------------------------------------------- the pool

#[tokio::test]
#[serial_test::serial]
async fn run_reaches_the_installed_database_and_refuses_nested_access() {
    let test = super::testing::test_db();
    super::run(|conn| insert_agent(conn, "agent-1"))
        .await
        .unwrap();
    let ids: Vec<String> = super::read(|conn| {
        Ok(agent_workspaces::table
            .select(agent_workspaces::id)
            .load(conn)?)
    })
    .await
    .unwrap();
    assert_eq!(ids, vec!["agent-1".to_string()]);

    let nested = super::run(|_conn| super::run_sync(|_| Ok(())))
        .await
        .unwrap_err();
    assert!(
        nested.to_string().contains("nested database access"),
        "{nested}"
    );
    assert_eq!(
        super::database().unwrap().path(),
        test.path.to_string_lossy()
    );
}

#[tokio::test]
#[serial_test::serial]
async fn a_transaction_that_fails_rolls_back() {
    let _test = super::testing::test_db();
    let result: anyhow::Result<()> = super::run(|conn| {
        conn.transaction(|conn| {
            insert_agent(conn, "agent-1")?;
            anyhow::bail!("stop")
        })
    })
    .await;
    assert_eq!(result.unwrap_err().to_string(), "stop");
    let n: i64 = super::read(|conn| Ok(agent_workspaces::table.count().get_result(conn)?))
        .await
        .unwrap();
    assert_eq!(n, 0);
}

// ---------------------------------------------------------------- the Prisma CLI

/// The Prisma CLI of the checkout, or of a checkout this one sits in.
fn prisma_cli() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PRISMA_CLI") {
        return Some(PathBuf::from(path));
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .map(|dir| dir.join("node_modules/.bin/prisma"))
        .find(|p| p.exists())
}

fn run_prisma(cli: &Path, config: &Path, args: &[&str]) -> String {
    let output = Command::new(cli)
        .args(args)
        .arg("--config")
        .arg(config)
        .env("PRISMA_HIDE_UPDATE_MESSAGE", "1")
        .env("CHECKPOINT_DISABLE", "1")
        .output()
        .expect("run the Prisma CLI");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.status.success(), "prisma {args:?} failed:\n{text}");
    text
}

fn write_prisma_config(dir: &Path, file: &Path) -> PathBuf {
    let config = dir.join("prisma.config.ts");
    std::fs::write(
        &config,
        format!(
            "export default {{\n  schema: {:?},\n  datasource: {{ url: {:?} }},\n}};\n",
            SCHEMA_DIR.join("schema.prisma").to_string_lossy(),
            format!("file:{}", file.display()),
        ),
    )
    .unwrap();
    config
}

#[test]
fn shares_the_migration_bookkeeping_with_the_prisma_cli() {
    let Some(cli) = prisma_cli().filter(|_| Command::new("node").arg("--version").output().is_ok())
    else {
        eprintln!("skipped: no Prisma CLI or node on this machine");
        return;
    };

    // This runner first: the CLI finds nothing to apply and no drift.
    let (dir, file) = temp_file();
    let config = write_prisma_config(dir.path(), &file);
    let mut conn = super::open_connection(&file.to_string_lossy()).unwrap();
    migrate(&mut conn).unwrap();
    drop(conn);
    assert!(
        run_prisma(&cli, &config, &["migrate", "deploy"])
            .contains("No pending migrations to apply.")
    );
    assert!(
        run_prisma(&cli, &config, &["migrate", "status"])
            .contains("Database schema is up to date!")
    );

    // The CLI first: this runner finds nothing to apply, and both wrote the same table.
    let (dir, file) = temp_file();
    let config = write_prisma_config(dir.path(), &file);
    run_prisma(&cli, &config, &["migrate", "deploy"]);
    let mut conn = super::open_connection(&file.to_string_lossy()).unwrap();
    assert!(migrate(&mut conn).unwrap().is_empty());
    let cli_table = text(
        &mut conn,
        "SELECT sql AS value FROM sqlite_master WHERE name = '_prisma_migrations'",
    );
    let mut ours = super::open_connection(":memory:").unwrap();
    apply_migrations(&mut ours, &[]).unwrap();
    assert_eq!(
        cli_table,
        text(
            &mut ours,
            "SELECT sql AS value FROM sqlite_master WHERE name = '_prisma_migrations'"
        )
    );
    drop(conn);

    // Half each: the CLI applies the rest after this runner, then this runner sees all.
    let (dir, file) = temp_file();
    let config = write_prisma_config(dir.path(), &file);
    let mut conn = super::open_connection(&file.to_string_lossy()).unwrap();
    apply_migrations(&mut conn, &MIGRATIONS[..MIGRATIONS.len() / 2]).unwrap();
    drop(conn);
    assert!(
        run_prisma(&cli, &config, &["migrate", "deploy"])
            .contains("All migrations have been successfully applied.")
    );
    let mut conn = super::open_connection(&file.to_string_lossy()).unwrap();
    assert!(migrate(&mut conn).unwrap().is_empty());
    #[derive(QueryableByName)]
    struct Types {
        #[diesel(sql_type = Text)]
        types: String,
    }
    let types = diesel::sql_query(
        r#"SELECT group_concat(DISTINCT typeof(started_at) || '/' || typeof(finished_at) || '/' || applied_steps_count) AS types FROM "_prisma_migrations""#,
    )
    .get_result::<Types>(&mut conn)
    .unwrap()
    .types;
    assert_eq!(types, "integer/integer/1");
}

#[test]
fn opens_a_read_only_connection_to_an_existing_file_only() {
    let (_dir, file) = temp_file();
    assert!(super::open_readonly(&file.to_string_lossy()).is_err());
    let mut conn = super::open_connection(&file.to_string_lossy()).unwrap();
    conn.batch_execute("CREATE TABLE t (x INTEGER)").unwrap();
    drop(conn);
    let mut readonly = super::open_readonly(&file.to_string_lossy()).unwrap();
    assert!(readonly.batch_execute("INSERT INTO t VALUES (1)").is_err());
    crate::lib::sqlite_bootstrap::load_sqlite_vec(&mut readonly).unwrap();
}

#[test]
fn opens_a_database_whose_path_needs_uri_escaping() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a?b#c%d.db");
    let db = Database::open(Some(&format!("file:{}", file.display()))).unwrap();
    let db = Arc::new(db);
    db.run_sync(|conn| Ok(conn.batch_execute("CREATE TABLE t (x INTEGER)")?))
        .unwrap();
    assert!(file.exists());
    super::open_readonly(&file.to_string_lossy()).unwrap();
}
