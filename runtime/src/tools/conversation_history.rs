//! The compacted-history tool — reads the messages a compaction summary replaced.
//!
//! A summary keeps what a later turn most likely needs; this tool returns the exact
//! words when it does not. The rows stay in the database after a compaction, marked
//! `isCompacted`, so nothing is lost, only out of the context.
//!
//! Bound to the turn's thread: the model cannot name another conversation.

use serde::Deserialize;
use serde_json::Value;

use crate::ai::ToolSet;

pub const COMPACTED_HISTORY_TOOL_NAME: &str = "read_compacted_history";
pub const COMPACTED_HISTORY_DESCRIPTION: &str = "Read the earlier messages of this conversation that its summary replaced, oldest first, with their tool calls and results. Use it when you need an exact detail the summary does not give: a command, an error, a value, what the user said word for word. Each message has a position. A page cuts long texts; give a query to see the part around a match. Give a position as offset, without a query, to read from that message onward; a smaller offset reads the messages before it. Give position to read one message in full.";

pub const PAGE_SIZE: i64 = 20;

/// The text a page may hold, under the 30,000-character tool budget: a page cut by
/// that budget would hide messages its next offset skips.
pub const PAGE_CHARS: usize = 20_000;

/// Each message text, tool input and tool result in a page is cut to this many
/// characters, around the query's match when there is one, so every page fits the
/// budget. A read of one message by position is cut by `PAGE_CHARS` alone.
pub const OUTPUT_CHARS: usize = 2_000;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CompactedHistoryInput {
    /// Return only the messages whose text or tool calls contain this, ignoring case.
    #[serde(default)]
    pub query: Option<String>,
    /// How many messages to skip, for the next page. Default 0.
    #[serde(default)]
    pub offset: Option<i64>,
    /// Read the message at this position in full, uncut.
    #[serde(default)]
    pub position: Option<i64>,
    /// With position: the character to start from. Default 0.
    #[serde(default)]
    pub start: Option<i64>,
}

pub fn compacted_history_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

/// A page of the compacted messages (`{ messages, nextOffset? }`, or
/// `{ messages: [], note }`), or one message in full when `position` is given.
pub async fn run_read_compacted_history(
    input: CompactedHistoryInput,
    thread_id: &str,
    workspace_root: Option<&str>,
) -> anyhow::Result<Value> {
    todo!()
}

/// `read_compacted_history`, bound to the thread.
pub fn get_conversation_history_tools(thread_id: &str, workspace_root: Option<&str>) -> ToolSet {
    todo!()
}

/// One stored tool call, as the `toolCalls` column holds it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct StoredCall {
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub input: Option<Value>,
    #[serde(default)]
    pub output: Option<Value>,
    #[serde(default)]
    pub truncated: Option<StoredTruncation>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTruncation {
    #[serde(default)]
    pub spill_id: Option<String>,
}

/// The first `OUTPUT_CHARS` of a long text, or the window around the query's first
/// match in it, with `[From character <n>.]` before a window that does not start
/// at 0 and `[Cut: 2000 of <length> characters shown. Call with position <p> to
/// read this message in full.]` after. Lengths and positions are UTF-16 units.
fn clip(output: &Value, query: Option<&str>, position: i64) -> Value {
    todo!()
}
