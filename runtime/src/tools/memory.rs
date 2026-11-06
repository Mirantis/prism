//! Memory tools.
//!
//! The factory closes over (user, agent) so the tool surface is pre-bound when
//! handed to `invoke()`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai::ToolSet;

pub const BOUND_FORMAT: &str = "Give a UTC date (2026-10-06, the whole day) or a date-time with an offset (2026-10-06T14:30:00Z).";
pub const MEMORY_SEARCH_DESCRIPTION: &str =
    "Search your memory for relevant information. Without a query, lists the most recent entries.";
pub const MEMORY_WRITE_DESCRIPTION: &str = "Store important information to your memory. User preferences go here, with the category observation.";
pub const MEMORY_DELETE_DESCRIPTION: &str = "Delete memory entries that are no longer relevant.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemorySort {
    Relevance,
    Newest,
}

impl MemorySort {
    pub fn as_str(self) -> &'static str {
        match self {
            MemorySort::Relevance => "relevance",
            MemorySort::Newest => "newest",
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct MemorySearchInput {
    /// What to search for in memory, by meaning.
    #[serde(default)]
    pub query: Option<String>,
    /// Filter by categories.
    #[serde(default)]
    pub categories: Option<Vec<String>>,
    /// Maximum results (default: 25).
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub sort: Option<MemorySort>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryWriteCategory {
    Observation,
    Action,
    Decision,
    Event,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MemoryWriteInput {
    /// What to remember.
    pub content: String,
    /// Category of information.
    pub category: MemoryWriteCategory,
    /// Importance score 1-10 (default: 5).
    #[serde(default)]
    pub importance: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteInput {
    /// IDs of memory entries to delete.
    pub entry_ids: Vec<String>,
    /// Brief reason for deletion.
    #[serde(default)]
    pub reason: Option<String>,
}

pub fn memory_search_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn memory_write_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn memory_delete_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bound {
    Since,
    Until,
}

impl Bound {
    pub fn as_str(self) -> &'static str {
        match self {
            Bound::Since => "since",
            Bound::Until => "until",
        }
    }
}

/// One bound of the search window. A bare date (`z.iso.date()`) covers that whole
/// day in UTC, the zone the agent's prompt gives the date in, so a `since` and an
/// `until` of one date search that day; a date-time needs an offset
/// (`z.iso.datetime({ offset: true })`).
pub fn parse_bound(bound: Bound, value: &str) -> Option<DateTime<Utc>> {
    todo!()
}

/// The search window, or the error the model reads:
/// `<bound> is not a date or a date-time: "<value>". <BOUND_FORMAT>`, or
/// `since (<since>) is after until (<until>).`
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchWindow {
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
}

pub fn parse_window(since: Option<&str>, until: Option<&str>) -> Result<SearchWindow, String> {
    todo!()
}

/// memory_search, memory_write, memory_delete. The search emits `memory searched`.
pub fn get_memory_tools(user_id: &str, agent_id: &str) -> ToolSet {
    todo!()
}
