//! The tool calls the agent has stored, paged newest first.
//!
//! Paging is over *message rows* rather than over tool calls, because the calls
//! live inside a JSON array: one row can hold anything from a single call to a
//! hundred. A cursor therefore names a row and a position inside that row's
//! array, and a page is assembled by walking rows newest-first until it holds
//! enough calls.

use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::sqlite::Sqlite;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::CONFIG;
use crate::db::models::MessageRole;
use crate::db::schema::conversation_messages::dsl as msg;
use crate::db::schema::conversation_threads::dsl as thr;
use crate::db::sql_types::DbDateTime;
use crate::services::message_delivery_service::MessageTrigger;
use crate::support::js::{len16, parse_int, slice16};
use crate::types::ToolCallRecord;

/// Message rows read per batch while filling one page. Each row carries its whole
/// `toolCalls` array, and a call's stored output is the model-facing view capped
/// by `lib/tool_output_limiter.rs`, so a batch is bounded at roughly that cap
/// times the calls in a turn.
const ROW_BATCH: i64 = 25;

/// Bound on batches per page, so a long run of call-less rows cannot spin.
const MAX_ROW_BATCHES: usize = 20;

/// Per-call display caps, applied to what a page serves.
const MAX_INPUT_CHARS: usize = 2_000;
const MAX_OUTPUT_CHARS: usize = 10_000;

/// `Number.prototype.toLocaleString()` in `en-US` for a count: digits grouped by
/// thousands with commas.
fn group_thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Cut `text` to `max`, saying so in place.
fn cap(text: &str, max: usize) -> String {
    let length = len16(text);
    if length <= max {
        return text.to_string();
    }
    format!(
        "{}\n… truncated for this view: {} of {} characters",
        slice16(text, 0, max),
        group_thousands(max),
        group_thousands(length)
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallHistoryEntry {
    #[serde(flatten)]
    pub call: ToolCallRecord,
    /// Stable per-call id: the row plus the position inside its stored array.
    pub id: String,
    pub message_id: String,
    pub thread_id: String,
    pub thread_title: Option<String>,
    pub triggered_by: MessageTrigger,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallHistoryPage {
    pub items: Vec<ToolCallHistoryEntry>,
    /// Cursor for the next page, or null at the end of history.
    pub next_cursor: Option<String>,
}

/// `<messageId>:<indexInStoredArray>` — opaque to the client.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Position {
    message_id: String,
    index: usize,
}

fn parse_cursor(raw: Option<&str>) -> Option<Position> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let at = raw.rfind(':')?;
    if at == 0 {
        return None;
    }
    let index = parse_int(&raw[at + 1..])?;
    if index < 0 {
        return None;
    }
    Some(Position {
        message_id: raw[..at].to_string(),
        index: index as usize,
    })
}

/// One stored tool call and its position in the stored array.
#[derive(Debug, Clone)]
pub struct IndexedToolCall {
    pub index: usize,
    pub call: ToolCallRecord,
}

/// One row's stored tool calls, newest first.
///
/// Parsed defensively, as `parse_tool_calls` in `prompts/context_builder.rs` does:
/// the column is JSON, so an entry's shape is a convention rather than a
/// constraint. The stored array is in step order, so walking it backwards puts
/// the row's latest call first.
///
/// `index` is the position in the *stored* array, not in this reversed view, so
/// a cursor built from it stays valid however the page is read.
pub fn read_tool_calls(stored: &serde_json::Value) -> Vec<IndexedToolCall> {
    let Some(stored) = stored.as_array() else {
        return Vec::new();
    };

    let mut calls = Vec::new();
    for (index, entry) in stored.iter().enumerate().rev() {
        let Some(entry) = entry.as_object() else {
            continue;
        };
        let Some(tool) = entry
            .get("tool")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        else {
            continue;
        };
        let text = |key: &str| entry.get(key).and_then(Value::as_str);

        calls.push(IndexedToolCall {
            index,
            call: ToolCallRecord {
                tool: tool.to_string(),
                input: text("input")
                    .map(|input| cap(input, MAX_INPUT_CHARS))
                    .unwrap_or_default(),
                output: text("output")
                    .map(|output| cap(output, MAX_OUTPUT_CHARS))
                    .unwrap_or_default(),
                success: entry.get("success") == Some(&Value::Bool(true)),
                timestamp: text("timestamp").unwrap_or_default().to_string(),
                rendered: false,
                truncated: None,
            },
        });
    }

    calls
}

/// The columns a page reads, the thread's title included.
type RowTuple = (
    String,
    String,
    MessageTrigger,
    Option<Value>,
    DateTime<Utc>,
    Option<String>,
);

fn to_row(t: RowTuple) -> ToolCallRow {
    ToolCallRow {
        id: t.0,
        thread_id: t.1,
        triggered_by: t.2,
        tool_calls: t.3,
        created_at: t.4,
        thread_title: t.5,
    }
}

/// A message row as a page reads it.
#[derive(Debug, Clone)]
struct ToolCallRow {
    id: String,
    thread_id: String,
    triggered_by: MessageTrigger,
    tool_calls: Option<serde_json::Value>,
    created_at: DateTime<Utc>,
    thread_title: Option<String>,
}

/// What `next_cursor` decides from.
struct CursorState<'a> {
    filled: bool,
    exhausted: bool,
    positions: &'a [Position],
    last_row_id: Option<&'a str>,
}

pub struct ToolCallHistoryService;

/// The message rows of the agent this runtime owns: role AGENT, in a thread whose
/// `agentId` is the owner. A subagent is its own `AgentWorkspace` row in the same
/// database, and the thread carries the owner.
macro_rules! owned_rows {
    ($owner:expr) => {
        msg::conversation_messages
            .inner_join(thr::conversation_threads)
            .filter(msg::role.eq(MessageRole::Agent))
            .filter(thr::agent_id.eq($owner))
            .select((
                msg::id,
                msg::thread_id,
                msg::triggered_by,
                msg::tool_calls,
                msg::created_at,
                thr::title,
            ))
            .into_boxed::<Sqlite>()
    };
}

/// Adds one call to the page, with the row's provenance.
fn emit(
    items: &mut Vec<ToolCallHistoryEntry>,
    positions: &mut Vec<Position>,
    row: &ToolCallRow,
    index: usize,
    call: ToolCallRecord,
) {
    items.push(ToolCallHistoryEntry {
        call,
        id: format!("{}-tc-{}", row.id, index),
        message_id: row.id.clone(),
        thread_id: row.thread_id.clone(),
        thread_title: row.thread_title.clone(),
        triggered_by: row.triggered_by,
    });
    positions.push(Position {
        message_id: row.id.clone(),
        index,
    });
}

impl ToolCallHistoryService {
    pub fn new() -> Self {
        ToolCallHistoryService
    }

    /// One page of tool calls across every thread and trigger.
    ///
    /// Ordered by the turn that produced them, newest turn first, then by
    /// position within a turn, so two turns running at once can interleave.
    /// Ordering on each call's own timestamp needs the calls in their own table.
    ///
    /// Two phases, because one row can hold more calls than fit on a page: resume
    /// inside the cursor's row first, then walk strictly older rows. An unset
    /// agent id answers empty, as the usage read does. Rows belong to the agent
    /// this runtime owns: role AGENT, in a thread whose `agentId` is the owner.
    pub async fn page(
        &self,
        limit: usize,
        raw_cursor: Option<&str>,
    ) -> anyhow::Result<ToolCallHistoryPage> {
        // An unset id would filter on nothing and return every agent's calls, so
        // it answers empty, as the usage read does.
        let Some(owner) = CONFIG.agent_id().filter(|id| !id.is_empty()) else {
            return Ok(ToolCallHistoryPage {
                items: Vec::new(),
                next_cursor: None,
            });
        };

        let cursor = parse_cursor(raw_cursor);
        let mut items: Vec<ToolCallHistoryEntry> = Vec::new();
        // Parallel to `items`: the stored-array position each one came from, so the
        // next cursor is read off the last call emitted rather than parsed back out
        // of its id.
        let mut positions: Vec<Position> = Vec::new();

        // Where the older-rows walk resumes, and the oldest row it has reached.
        let mut after: Option<(DateTime<Utc>, String)> = None;
        let mut last_row_id: Option<String> = None;
        let mut exhausted = false;

        if let Some(cursor) = &cursor {
            // The row has to belong to this agent, so the client-supplied id is
            // checked against the owner rather than trusted.
            let owner_id = owner.clone();
            let message_id = cursor.message_id.clone();
            let row = crate::db::read(move |conn| {
                Ok(owned_rows!(&owner_id)
                    .filter(msg::id.eq(&message_id))
                    .first::<RowTuple>(conn)
                    .optional()?)
            })
            .await?;

            // The cursor's row is gone — its thread was deleted while the client was
            // scrolling. End the list; a reload starts from a history that exists.
            let Some(row) = row.map(to_row) else {
                return Ok(ToolCallHistoryPage {
                    items: Vec::new(),
                    next_cursor: None,
                });
            };

            let stored = row.tool_calls.clone().unwrap_or(Value::Null);
            for IndexedToolCall { index, call } in read_tool_calls(&stored) {
                // Positions descend, so anything at or above the cursor's index has
                // already been sent.
                if index >= cursor.index {
                    continue;
                }
                if items.len() == limit {
                    break;
                }
                emit(&mut items, &mut positions, &row, index, call);
            }

            after = Some((row.created_at, row.id.clone()));
            last_row_id = Some(row.id.clone());
        }

        let mut batch = 0;
        while batch < MAX_ROW_BATCHES && items.len() < limit {
            batch += 1;
            let owner_id = owner.clone();
            let older_than = after.clone();
            let rows: Vec<ToolCallRow> = crate::db::read(move |conn| {
                let mut query = owned_rows!(&owner_id);
                // Strictly older than the last row read, compared on (createdAt, id)
                // because createdAt alone is not unique — two rows written in the same
                // millisecond would otherwise repeat or go missing.
                if let Some((created_at, id)) = older_than {
                    let at = DbDateTime(created_at);
                    query = query.filter(
                        msg::created_at
                            .lt(at)
                            .or(msg::created_at.eq(at).and(msg::id.lt(id))),
                    );
                }
                let rows: Vec<RowTuple> = query
                    .order((msg::created_at.desc(), msg::id.desc()))
                    .limit(ROW_BATCH)
                    .load(conn)?;
                Ok(rows.into_iter().map(to_row).collect())
            })
            .await?;

            // A short batch is the end of history, an empty one included — that is
            // what a cursor on the oldest row reads. Set before the break, so the
            // cursor goes null and the client stops asking.
            if (rows.len() as i64) < ROW_BATCH {
                exhausted = true;
            }
            if rows.is_empty() {
                break;
            }

            for row in &rows {
                if items.len() == limit {
                    break;
                }

                after = Some((row.created_at, row.id.clone()));
                last_row_id = Some(row.id.clone());

                let stored = row.tool_calls.clone().unwrap_or(Value::Null);
                for IndexedToolCall { index, call } in read_tool_calls(&stored) {
                    if items.len() == limit {
                        break;
                    }
                    emit(&mut items, &mut positions, row, index, call);
                }
            }

            if exhausted {
                break;
            }
        }

        let next_cursor = self.next_cursor(CursorState {
            filled: items.len() == limit,
            exhausted,
            positions: &positions,
            last_row_id: last_row_id.as_deref(),
        });
        Ok(ToolCallHistoryPage { items, next_cursor })
    }

    /// Where the next page resumes, or `None` once history is spent.
    ///
    /// A page that filled gets a cursor naming the last call emitted, since the
    /// page may have stopped part-way through a row; the cost is one empty page
    /// when the limit lands on a row's last call. A page that did not fill ran out
    /// of rows or of batches. Out of rows ends the list. Out of batches resumes at
    /// the last row read, index 0.
    fn next_cursor(&self, state: CursorState<'_>) -> Option<String> {
        let last = state.positions.last();
        if state.filled {
            if let Some(last) = last {
                return Some(format!("{}:{}", last.message_id, last.index));
            }
        }
        if state.exhausted {
            return None;
        }
        state.last_row_id.map(|id| format!("{id}:0"))
    }
}

impl Default for ToolCallHistoryService {
    fn default() -> Self {
        Self::new()
    }
}

pub static TOOL_CALL_HISTORY_SERVICE: LazyLock<ToolCallHistoryService> =
    LazyLock::new(ToolCallHistoryService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{NewAgentWorkspace, NewConversationMessage, NewConversationThread};
    use crate::db::schema::agent_workspaces::dsl as w;
    use crate::db::testing::test_db;
    use serde_json::json;

    fn call(tool: &str) -> Value {
        json!({
            "tool": tool,
            "input": json!({ "command": format!("run {tool}") }).to_string(),
            "output": "\"done\"",
            "success": true,
            "timestamp": "2026-08-27T09:00:00.000Z",
        })
    }

    /// The owner, a second agent, and one thread of each.
    fn seed() {
        crate::db::run_sync(|conn| {
            for (agent, thread) in [("test-agent-id", "thread-1"), ("other", "thread-2")] {
                let mut row = NewAgentWorkspace::new("u", "", "", "", "", "");
                row.id = agent.to_string();
                diesel::insert_into(w::agent_workspaces)
                    .values(&row)
                    .execute(conn)?;
                let mut t = NewConversationThread::new(agent, "u");
                t.id = thread.to_string();
                t.title = Some("A thread".to_string());
                diesel::insert_into(thr::conversation_threads)
                    .values(&t)
                    .execute(conn)?;
            }
            Ok(())
        })
        .unwrap();
    }

    fn message(id: &str, thread: &str, tool_calls: Value, created_at: &str) {
        let mut row =
            NewConversationMessage::new(thread, MessageRole::Agent, "", MessageTrigger::UserInput);
        row.id = id.to_string();
        row.tool_calls = Some(tool_calls);
        row.created_at = DbDateTime(crate::support::parse_iso(created_at).unwrap());
        crate::db::run_sync(move |conn| {
            diesel::insert_into(msg::conversation_messages)
                .values(&row)
                .execute(conn)?;
            Ok(())
        })
        .unwrap();
    }

    const AT: &str = "2026-08-27T09:00:00.000Z";

    fn tools(page: &ToolCallHistoryPage) -> Vec<&str> {
        page.items.iter().map(|i| i.call.tool.as_str()).collect()
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn returns_a_rows_calls_newest_first_with_provenance() {
        let _db = test_db();
        seed();
        message(
            "msg-1",
            "thread-1",
            json!([call("first"), call("second")]),
            AT,
        );

        let page = TOOL_CALL_HISTORY_SERVICE.page(30, None).await.unwrap();

        assert_eq!(tools(&page), ["second", "first"]);
        let json = serde_json::to_value(&page.items[0]).unwrap();
        assert_eq!(json["id"], "msg-1-tc-1");
        assert_eq!(json["messageId"], "msg-1");
        assert_eq!(json["threadId"], "thread-1");
        assert_eq!(json["threadTitle"], "A thread");
        assert_eq!(json["triggeredBy"], "USER_INPUT");
        assert_eq!(json["success"], true);
        assert_eq!(page.next_cursor, None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn pages_only_the_agent_this_runtime_owns() {
        let _db = test_db();
        seed();
        message("mine", "thread-1", json!([call("mine")]), AT);
        message("theirs", "thread-2", json!([call("theirs")]), AT);

        let page = TOOL_CALL_HISTORY_SERVICE.page(30, None).await.unwrap();
        assert_eq!(tools(&page), ["mine"]);

        // A cursor naming another agent's row is not resumed from.
        let page = TOOL_CALL_HISTORY_SERVICE
            .page(30, Some("theirs:3"))
            .await
            .unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.next_cursor, None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn stops_at_the_limit_mid_row_and_resumes_below_that_position() {
        let _db = test_db();
        seed();
        message(
            "msg-1",
            "thread-1",
            json!([call("a"), call("b"), call("c"), call("d")]),
            AT,
        );

        let first = TOOL_CALL_HISTORY_SERVICE.page(2, None).await.unwrap();
        assert_eq!(tools(&first), ["d", "c"]);
        assert_eq!(first.next_cursor.as_deref(), Some("msg-1:2"));

        let second = TOOL_CALL_HISTORY_SERVICE
            .page(2, Some("msg-1:2"))
            .await
            .unwrap();
        assert_eq!(tools(&second), ["b", "a"]);
        let ids: Vec<&str> = second.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["msg-1-tc-1", "msg-1-tc-0"]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn walks_the_whole_history_exactly_once_one_call_per_page() {
        let _db = test_db();
        seed();
        message(
            "msg-3",
            "thread-1",
            json!([call("e")]),
            "2026-08-27T10:00:00.000Z",
        );
        message("msg-2", "thread-1", json!([call("c"), call("d")]), AT);
        message("msg-1", "thread-1", json!([call("a"), call("b")]), AT);

        let mut seen: Vec<String> = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let page = TOOL_CALL_HISTORY_SERVICE
                .page(1, cursor.as_deref())
                .await
                .unwrap();
            seen.extend(page.items.iter().map(|i| i.id.clone()));
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }

        assert_eq!(
            seen,
            [
                "msg-3-tc-0",
                "msg-2-tc-1",
                "msg-2-tc-0",
                "msg-1-tc-1",
                "msg-1-tc-0"
            ]
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn stops_paging_once_the_cursor_sits_on_the_oldest_call() {
        let _db = test_db();
        seed();
        message("msg-1", "thread-1", json!([call("a")]), AT);

        let page = TOOL_CALL_HISTORY_SERVICE
            .page(30, Some("msg-1:0"))
            .await
            .unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.next_cursor, None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn ignores_a_malformed_cursor_and_starts_from_the_newest_row() {
        let _db = test_db();
        seed();
        message("msg-1", "thread-1", json!([call("a")]), AT);

        let page = TOOL_CALL_HISTORY_SERVICE
            .page(30, Some("nonsense"))
            .await
            .unwrap();
        assert_eq!(tools(&page), ["a"]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn hands_back_a_cursor_when_the_batch_bound_stops_a_short_page() {
        let _db = test_db();
        seed();
        for i in 0..520 {
            message(&format!("empty-{i:04}"), "thread-1", json!([]), AT);
        }

        let page = TOOL_CALL_HISTORY_SERVICE.page(30, None).await.unwrap();

        assert!(page.items.is_empty());
        // Twenty batches of 25 read the 500 newest rows, ids descending.
        assert_eq!(page.next_cursor.as_deref(), Some("empty-0020:0"));
    }

    #[test]
    fn caps_the_text_it_serves_and_says_how_much_it_cut() {
        let huge_input = json!({ "command": "y".repeat(9_000) }).to_string();
        let calls = read_tool_calls(&json!([{
            "tool": "shell_exec",
            "input": huge_input,
            "output": "x".repeat(60_000),
            "success": true,
            "timestamp": AT,
        }]));
        let item = &calls[0].call;
        assert!(item.output.len() < 11_000);
        assert!(item.input.len() < 2_400);
        assert!(item.output.contains("10,000 of 60,000 characters"));
        assert!(item.output.starts_with(&"x".repeat(100)));
    }

    #[test]
    fn leaves_text_that_fits_exactly_as_it_was_stored() {
        let calls = read_tool_calls(&json!([{
            "tool": "shell_exec",
            "input": "{\"command\":\"ls\"}",
            "output": "\"a.txt\"",
        }]));
        assert_eq!(calls[0].call.input, "{\"command\":\"ls\"}");
        assert_eq!(calls[0].call.output, "\"a.txt\"");
    }

    #[test]
    fn skips_malformed_entries_and_columns_that_are_not_an_array() {
        let calls =
            read_tool_calls(&json!([null, { "input": "{}" }, { "tool": "" }, call("real")]));
        let tools: Vec<&str> = calls.iter().map(|c| c.call.tool.as_str()).collect();
        assert_eq!(tools, ["real"]);
        assert_eq!(calls[0].index, 3);
        assert!(read_tool_calls(&json!("not an array")).is_empty());
    }

    #[test]
    fn fills_in_missing_fields_rather_than_dropping_a_named_call() {
        let calls = read_tool_calls(&json!([{ "tool": "shell_exec" }]));
        let c = &calls[0].call;
        assert_eq!(
            (
                c.input.as_str(),
                c.output.as_str(),
                c.success,
                c.timestamp.as_str()
            ),
            ("", "", false, "")
        );
    }

    #[test]
    fn parses_only_a_cursor_with_a_row_and_a_non_negative_index() {
        assert_eq!(
            parse_cursor(Some("msg-1:2")),
            Some(Position {
                message_id: "msg-1".to_string(),
                index: 2
            })
        );
        assert_eq!(parse_cursor(Some("nonsense")), None);
        assert_eq!(parse_cursor(Some(":3")), None);
        assert_eq!(parse_cursor(Some("a:-1")), None);
        assert_eq!(parse_cursor(None), None);
    }
}
