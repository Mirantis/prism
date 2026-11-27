//! The full-text index of the agent's messages, and the one query that reads it.
//!
//! `message_search` is an FTS5 table with one row per `message_search_entries` row,
//! under the entry's id. Triggers on `conversation_messages` and `channel_messages`
//! write both, so every writer of a message keeps the index current. [`ensure`]
//! creates the table and the triggers at every boot, because a migration that
//! rebuilds a table drops that table's triggers, and then indexes the messages that
//! have no entry yet.
//!
//! A message's indexed text is its content and, for each tool call, the tool's name
//! and input, cut to [`INDEXED_CHARS`]. Tool results are not indexed. SYSTEM rows are
//! not indexed either: they hold the runtime's own records, such as tool changes.
//!
//! FTS5 `MATCH` is outside what Diesel's query builder expresses, so the search is
//! hand-written SQL, as the schema statements here are.

use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_types::{BigInt, Bool, Nullable, Text};
use serde_json::json;

use crate::log_info;

/// How much of a message the index holds, in characters, from its start.
pub const INDEXED_CHARS: i64 = 8_192;

/// The words of a match's excerpt, around the match.
const EXCERPT_TOKENS: i64 = 40;

/// `createdAt` in epoch milliseconds. The runtime writes milliseconds; a row that took
/// the column's `CURRENT_TIMESTAMP` default holds text, which becomes milliseconds too.
fn epoch_ms(column: &str) -> String {
    format!(
        "CASE WHEN typeof({column}) IN ('integer', 'real') THEN CAST({column} AS INTEGER) \
         ELSE COALESCE(CAST(ROUND((julianday({column}) - 2440587.5) * 86400000) AS INTEGER), 0) END"
    )
}

/// The indexed text of a stored message: its content, then each tool call's name and
/// input. A `toolCalls` value that is not a JSON array adds nothing.
fn stored_text(row: &str) -> String {
    format!(
        r#"substr({row}."content" || COALESCE((
            SELECT ' ' || group_concat(COALESCE(json_extract(value, '$.tool'), '') || ' ' || COALESCE(json_extract(value, '$.input'), ''), ' ')
            FROM json_each(CASE WHEN json_valid({row}."toolCalls") AND json_type({row}."toolCalls") = 'array' THEN {row}."toolCalls" ELSE '[]' END)
            WHERE type = 'object'
        ), ''), 1, {INDEXED_CHARS})"#
    )
}

/// A message a person typed: a channel message with the same conversation replaces it.
fn person_message(row: &str) -> String {
    format!(r#"({row}."role" = 'USER' AND {row}."internalStep" = 0)"#)
}

/// A message written in a heartbeat, scheduled-task or webhook run.
fn automated(row: &str) -> String {
    format!(r#"({row}."triggeredBy" IN ('HEARTBEAT', 'CRON_TASK', 'WEBHOOK'))"#)
}

/// The messages the index holds.
fn indexed(row: &str) -> String {
    format!(r#"{row}."role" IN ('USER', 'AGENT')"#)
}

fn schema_sql() -> String {
    let new_ms = epoch_ms(r#"NEW."createdAt""#);
    let new_text = stored_text("NEW");
    let new_person = person_message("NEW");
    let new_automated = automated("NEW");
    let new_indexed = indexed("NEW");
    format!(
        r#"
CREATE VIRTUAL TABLE IF NOT EXISTS "message_search" USING fts5("text", tokenize = 'unicode61 remove_diacritics 2');

DROP TRIGGER IF EXISTS "message_search_entries_deleted";
CREATE TRIGGER "message_search_entries_deleted" AFTER DELETE ON "message_search_entries" BEGIN
  DELETE FROM "message_search" WHERE rowid = OLD."id";
END;

DROP TRIGGER IF EXISTS "conversation_messages_search_inserted";
CREATE TRIGGER "conversation_messages_search_inserted" AFTER INSERT ON "conversation_messages"
WHEN {new_indexed} BEGIN
  DELETE FROM "message_search_entries" WHERE "messageId" = NEW."id";
  INSERT INTO "message_search_entries" ("messageId", "threadId", "createdAtMs", "personMessage", "automated")
    VALUES (NEW."id", NEW."threadId", {new_ms}, {new_person}, {new_automated});
  INSERT INTO "message_search" (rowid, "text") VALUES (last_insert_rowid(), {new_text});
END;

DROP TRIGGER IF EXISTS "conversation_messages_search_updated";
CREATE TRIGGER "conversation_messages_search_updated"
AFTER UPDATE OF "content", "toolCalls", "triggeredBy", "internalStep", "createdAt" ON "conversation_messages"
WHEN {new_indexed} BEGIN
  UPDATE "message_search_entries"
    SET "createdAtMs" = {new_ms}, "personMessage" = {new_person}, "automated" = {new_automated}
    WHERE "messageId" = NEW."id";
  UPDATE "message_search" SET "text" = {new_text}
    WHERE rowid = (SELECT "id" FROM "message_search_entries" WHERE "messageId" = NEW."id");
END;

DROP TRIGGER IF EXISTS "channel_messages_search_inserted";
CREATE TRIGGER "channel_messages_search_inserted" AFTER INSERT ON "channel_messages" BEGIN
  DELETE FROM "message_search_entries" WHERE "channelMessageId" = NEW."id";
  INSERT INTO "message_search_entries" ("channelMessageId", "threadId", "createdAtMs", "personMessage", "automated")
    VALUES (NEW."id", NEW."threadId", {new_ms}, 0, 0);
  INSERT INTO "message_search" (rowid, "text") VALUES (last_insert_rowid(), substr(NEW."content", 1, {INDEXED_CHARS}));
END;

DROP TRIGGER IF EXISTS "channel_messages_search_updated";
CREATE TRIGGER "channel_messages_search_updated" AFTER UPDATE OF "content", "createdAt" ON "channel_messages" BEGIN
  UPDATE "message_search_entries" SET "createdAtMs" = {new_ms} WHERE "channelMessageId" = NEW."id";
  UPDATE "message_search" SET "text" = substr(NEW."content", 1, {INDEXED_CHARS})
    WHERE rowid = (SELECT "id" FROM "message_search_entries" WHERE "channelMessageId" = NEW."id");
END;
"#
    )
}

/// Index the stored and channel messages that have no entry, and give every entry
/// without index text its text.
fn backfill_sql() -> String {
    let ms = epoch_ms(r#"m."createdAt""#);
    let text = stored_text("m");
    let person = person_message("m");
    let automated = automated("m");
    let indexed = indexed("m");
    let channel_ms = epoch_ms(r#"c."createdAt""#);
    format!(
        r#"
INSERT INTO "message_search_entries" ("messageId", "threadId", "createdAtMs", "personMessage", "automated")
  SELECT m."id", m."threadId", {ms}, {person}, {automated} FROM "conversation_messages" m
  WHERE {indexed} AND NOT EXISTS (SELECT 1 FROM "message_search_entries" e WHERE e."messageId" = m."id");

INSERT INTO "message_search_entries" ("channelMessageId", "threadId", "createdAtMs", "personMessage", "automated")
  SELECT c."id", c."threadId", {channel_ms}, 0, 0 FROM "channel_messages" c
  WHERE NOT EXISTS (SELECT 1 FROM "message_search_entries" e WHERE e."channelMessageId" = c."id");

INSERT INTO "message_search" (rowid, "text")
  SELECT e."id", {text} FROM "message_search_entries" e JOIN "conversation_messages" m ON m."id" = e."messageId"
  WHERE NOT EXISTS (SELECT 1 FROM "message_search" s WHERE s.rowid = e."id");

INSERT INTO "message_search" (rowid, "text")
  SELECT e."id", substr(c."content", 1, {INDEXED_CHARS}) FROM "message_search_entries" e JOIN "channel_messages" c ON c."id" = e."channelMessageId"
  WHERE NOT EXISTS (SELECT 1 FROM "message_search" s WHERE s.rowid = e."id");
"#
    )
}

#[derive(QueryableByName)]
struct Count {
    #[diesel(sql_type = BigInt)]
    n: i64,
}

/// Create the index and its triggers, and index what is not indexed yet. Run after
/// the migrations, before anything else uses the database. One transaction, so a
/// process stopped part way leaves the work for the next boot.
pub fn ensure(conn: &mut SqliteConnection) -> anyhow::Result<()> {
    conn.immediate_transaction::<_, anyhow::Error, _>(|conn| {
        conn.batch_execute(&schema_sql())?;
        let before = diesel::sql_query(r#"SELECT count(*) AS n FROM "message_search_entries""#)
            .get_result::<Count>(conn)?
            .n;
        conn.batch_execute(&backfill_sql())?;
        let after = diesel::sql_query(r#"SELECT count(*) AS n FROM "message_search_entries""#)
            .get_result::<Count>(conn)?
            .n;
        if after > before {
            log_info!(
                json!({ "indexed": after - before, "total": after }),
                "[MessageSearchIndex] indexed messages"
            );
        }
        Ok(())
    })
}

/// A query in FTS5 syntax: each word of `text` as a quoted string, so punctuation is
/// never query syntax. A word that holds `-` or `.` stays one quoted string, which
/// FTS5 matches as a phrase (`my-app.config` finds the three words in a row).
/// `any_word` joins them with `OR`; otherwise every word has to match. `None` when
/// the text holds no word.
pub fn fts_query(text: &str, any_word: bool) -> Option<String> {
    let words: Vec<String> = text
        .split_whitespace()
        .map(|word| word.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|word| word.chars().any(char::is_alphanumeric))
        .take(MAX_QUERY_WORDS)
        .map(|word| format!("\"{}\"", word.replace('"', "\"\"")))
        .collect();
    if words.is_empty() {
        return None;
    }
    Some(words.join(if any_word { " OR " } else { " " }))
}

/// The words of a query the search uses; the rest are dropped.
const MAX_QUERY_WORDS: usize = 16;

/// One message the search found.
#[derive(Debug, Clone, PartialEq, QueryableByName)]
pub struct IndexHit {
    #[diesel(sql_type = Nullable<Text>, column_name = "messageId")]
    pub message_id: Option<String>,
    #[diesel(sql_type = Nullable<Text>, column_name = "channelMessageId")]
    pub channel_message_id: Option<String>,
    #[diesel(sql_type = Text, column_name = "threadId")]
    pub thread_id: String,
    #[diesel(sql_type = BigInt, column_name = "createdAtMs")]
    pub created_at_ms: i64,
    #[diesel(sql_type = Bool)]
    pub automated: bool,
    #[diesel(sql_type = Text)]
    pub excerpt: String,
}

/// What [`search`] reads.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct IndexQuery {
    /// FTS5 syntax, from [`fts_query`].
    pub matching: String,
    /// The agent whose conversations are searched.
    pub agent_id: String,
    pub thread_id: Option<String>,
    /// Inclusive, epoch milliseconds.
    pub after_ms: Option<i64>,
    /// Exclusive, epoch milliseconds.
    pub before_ms: Option<i64>,
    pub limit: i64,
}

/// The best matches, messages of heartbeat, scheduled-task and webhook runs after
/// the others. A person's stored message is left out when a channel message of its
/// conversation from that time on exists, because the channel's copy replaces it.
pub fn search(conn: &mut SqliteConnection, query: &IndexQuery) -> anyhow::Result<Vec<IndexHit>> {
    let sql = format!(
        r#"SELECT e."messageId", e."channelMessageId", e."threadId", e."createdAtMs", e."automated",
       snippet("message_search", 0, '', '', '…', {EXCERPT_TOKENS}) AS "excerpt"
FROM "message_search"
JOIN "message_search_entries" e ON e."id" = "message_search".rowid
JOIN "conversation_threads" th ON th."id" = e."threadId"
WHERE "message_search" MATCH ?
  AND th."agentId" = ?
  AND (? IS NULL OR e."threadId" = ?)
  AND (? IS NULL OR e."createdAtMs" >= ?)
  AND (? IS NULL OR e."createdAtMs" < ?)
  AND NOT COALESCE(e."messageId" IS NOT NULL AND e."personMessage" = 1 AND e."createdAtMs" >= (
    SELECT min(c."createdAt") FROM "channel_messages" c WHERE c."threadId" = e."threadId"
  ), 0)
ORDER BY e."automated", bm25("message_search")
LIMIT ?"#
    );
    Ok(diesel::sql_query(sql)
        .bind::<Text, _>(&query.matching)
        .bind::<Text, _>(&query.agent_id)
        .bind::<Nullable<Text>, _>(&query.thread_id)
        .bind::<Nullable<Text>, _>(&query.thread_id)
        .bind::<Nullable<BigInt>, _>(query.after_ms)
        .bind::<Nullable<BigInt>, _>(query.after_ms)
        .bind::<Nullable<BigInt>, _>(query.before_ms)
        .bind::<Nullable<BigInt>, _>(query.before_ms)
        .bind::<BigInt, _>(query.limit)
        .load::<IndexHit>(conn)?)
}

#[cfg(test)]
#[path = "message_search_index_tests.rs"]
mod tests;
