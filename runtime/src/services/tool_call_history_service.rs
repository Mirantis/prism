//! The tool calls the agent has stored, paged newest first.
//!
//! Paging is over *message rows* rather than over tool calls, because the calls
//! live inside a JSON array: one row can hold anything from a single call to a
//! hundred. A cursor therefore names a row and a position inside that row's
//! array, and a page is assembled by walking rows newest-first until it holds
//! enough calls.

use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

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
    todo!()
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
        todo!()
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
