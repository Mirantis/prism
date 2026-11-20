//! Memory tools.
//!
//! The factory closes over (user, agent) so the tool surface is pre-bound when
//! handed to `invoke()`.

use std::sync::LazyLock;

use chrono::{DateTime, NaiveDate, Utc};
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ai::{Tool, ToolSet, execute_fn, tool, zod_schema};
use crate::lib::locked_in::{LockedField, refuse_locked_write};
use crate::lib::telemetry::track_event;
use crate::services::agent_workspace_service::AGENT_WORKSPACE_SERVICE;
pub use crate::services::memory_manager_service::MemorySort;
use crate::services::memory_manager_service::{
    MEMORY_MANAGER_SERVICE, MemorySearchOptions, MemoryWriteInput as StoredMemoryInput,
};

pub const BOUND_FORMAT: &str = "Give a UTC date (2026-10-06, the whole day) or a date-time with an offset (2026-10-06T14:30:00Z).";
pub const MEMORY_SEARCH_DESCRIPTION: &str =
    "Search your memory for relevant information. Without a query, lists the most recent entries.";
pub const MEMORY_WRITE_DESCRIPTION: &str = "Store important information to your memory. User preferences go here, with the category observation.";
pub const MEMORY_DELETE_DESCRIPTION: &str = "Delete memory entries that are no longer relevant.";

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

impl MemoryWriteCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryWriteCategory::Observation => "observation",
            MemoryWriteCategory::Action => "action",
            MemoryWriteCategory::Decision => "decision",
            MemoryWriteCategory::Event => "event",
        }
    }
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
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "query": {
                "description": "What to search for in memory, by meaning",
                "type": "string"
            },
            "categories": {
                "description": "Filter by categories",
                "type": "array",
                "items": {
                    "type": "string"
                }
            },
            "limit": {
                "description": "Maximum results (default: 25)",
                "type": "integer",
                "minimum": 1,
                "maximum": 100
            },
            "since": {
                "description": format!("Only entries recorded at or after this time. {BOUND_FORMAT}"),
                "type": "string"
            },
            "until": {
                "description": format!("Only entries recorded at or before this time. {BOUND_FORMAT}"),
                "type": "string"
            },
            "sort": {
                "description": "relevance (default) puts the closest matches first, newest the most recent",
                "type": "string",
                "enum": ["relevance", "newest"]
            }
        },
        "additionalProperties": false
    })
}

pub fn memory_write_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": "What to remember"
            },
            "category": {
                "type": "string",
                "enum": ["observation", "action", "decision", "event"],
                "description": "Category of information"
            },
            "importance": {
                "description": "Importance score 1-10 (default: 5)",
                "type": "number"
            }
        },
        "required": ["content", "category"],
        "additionalProperties": false
    })
}

pub fn memory_delete_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "entryIds": {
                "type": "array",
                "items": {
                    "type": "string"
                },
                "description": "IDs of memory entries to delete"
            },
            "reason": {
                "description": "Brief reason for deletion",
                "type": "string"
            }
        },
        "required": ["entryIds"],
        "additionalProperties": false
    })
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

/// zod's `z.iso.date()`: a calendar date, February 29th only in a leap year.
static ISO_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))$",
    )
    .expect("valid pattern")
});

/// zod's `z.iso.datetime({ offset: true })`: a date, a time with seconds, and `Z` or
/// an offset.
static ISO_DATETIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$",
    )
    .expect("valid pattern")
});

/// One bound of the search window. A bare date (`z.iso.date()`) covers that whole
/// day in UTC, the zone the agent's prompt gives the date in, so a `since` and an
/// `until` of one date search that day; a date-time needs an offset
/// (`z.iso.datetime({ offset: true })`).
pub fn parse_bound(bound: Bound, value: &str) -> Option<DateTime<Utc>> {
    if ISO_DATE.is_match(value) {
        let day = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
        let time = match bound {
            Bound::Since => day.and_hms_milli_opt(0, 0, 0, 0)?,
            Bound::Until => day.and_hms_milli_opt(23, 59, 59, 999)?,
        };
        return Some(time.and_utc());
    }
    if !ISO_DATETIME.is_match(value) {
        return None;
    }
    // `new Date(value)` keeps whole milliseconds of a longer fraction.
    let parsed = DateTime::parse_from_rfc3339(value).ok()?;
    DateTime::from_timestamp_millis(parsed.timestamp_millis())
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
    let mut window = SearchWindow::default();
    for (bound, value) in [(Bound::Since, since), (Bound::Until, until)] {
        let Some(value) = value else {
            continue;
        };
        let Some(date) = parse_bound(bound, value) else {
            return Err(format!(
                "{} is not a date or a date-time: \"{value}\". {BOUND_FORMAT}",
                bound.as_str()
            ));
        };
        match bound {
            Bound::Since => window.since = Some(date),
            Bound::Until => window.until = Some(date),
        }
    }
    if let (Some(s), Some(u)) = (window.since, window.until)
        && s > u
    {
        return Err(format!(
            "since ({}) is after until ({}).",
            since.unwrap_or_default(),
            until.unwrap_or_default()
        ));
    }
    Ok(window)
}

/// The shape of a search, as `memory searched` reports it, without the query.
fn search_event(agent_id: &str, input: &MemorySearchInput) -> IndexMap<String, String> {
    let has_query = input
        .query
        .as_deref()
        .is_some_and(|q| !crate::support::js::trim(q).is_empty());
    let mut props = IndexMap::new();
    props.insert("agent.id".to_string(), agent_id.to_string());
    props.insert("memory.search.has_query".to_string(), has_query.to_string());
    props.insert(
        "memory.search.has_window".to_string(),
        (input.since.is_some() || input.until.is_some()).to_string(),
    );
    props.insert(
        "memory.search.sort".to_string(),
        input
            .sort
            .map_or("relevance", MemorySort::as_str)
            .to_string(),
    );
    props
}

async fn run_memory_search(user_id: &str, agent_id: &str, input: Value) -> anyhow::Result<Value> {
    let input: MemorySearchInput = serde_json::from_value(input)?;
    let mut searched = search_event(agent_id, &input);
    let window = match parse_window(input.since.as_deref(), input.until.as_deref()) {
        Ok(window) => window,
        Err(error) => {
            searched.insert(
                "memory.search.status".to_string(),
                "invalid_window".to_string(),
            );
            track_event("memory searched", Some(user_id), Some(searched));
            return Ok(json!({ "success": false, "error": error }));
        }
    };
    let results = MEMORY_MANAGER_SERVICE
        .search(
            user_id,
            input.query.as_deref(),
            &MemorySearchOptions {
                agent_id: agent_id.to_string(),
                categories: input.categories.clone(),
                limit: Some(input.limit.unwrap_or(25)),
                since: window.since,
                until: window.until,
                sort: input.sort,
            },
        )
        .await?;
    searched.insert("memory.search.status".to_string(), "ok".to_string());
    searched.insert(
        "memory.search.result_count".to_string(),
        results.len().to_string(),
    );
    track_event("memory searched", Some(user_id), Some(searched));
    Ok(json!({ "success": true, "count": results.len(), "results": results }))
}

async fn run_memory_write(user_id: &str, agent_id: &str, input: Value) -> anyhow::Result<Value> {
    let input: MemoryWriteInput = serde_json::from_value(input)?;
    // Locked-in mode freezes long-term memory too. Read live, so the lock
    // holds when it is switched on mid-turn.
    if AGENT_WORKSPACE_SERVICE.is_locked_in().await? {
        return Ok(serde_json::to_value(refuse_locked_write(
            agent_id,
            LockedField::MemoryEntry,
        ))?);
    }
    // The column is an integer, so a fractional score fails the write as Prisma
    // fails it.
    let importance = match input.importance {
        Some(score) if score.fract() != 0.0 || !score.is_finite() => {
            anyhow::bail!(
                "Invalid value provided. Expected Int, provided Float: importance {}",
                crate::support::js::number_text(score)
            )
        }
        Some(score) => Some(score as i64),
        None => None,
    };
    let entry = MEMORY_MANAGER_SERVICE
        .write(
            user_id,
            &StoredMemoryInput {
                content: input.content,
                category: input.category.as_str().to_string(),
                importance,
            },
            agent_id,
        )
        .await?;
    Ok(json!({
        "success": true,
        "entryId": entry.id,
        "category": input.category.as_str(),
        "importance": crate::support::js::number(input.importance.unwrap_or(5.0)),
    }))
}

async fn run_memory_delete(user_id: &str, agent_id: &str, input: Value) -> anyhow::Result<Value> {
    let input: MemoryDeleteInput = serde_json::from_value(input)?;
    if AGENT_WORKSPACE_SERVICE.is_locked_in().await? {
        return Ok(serde_json::to_value(refuse_locked_write(
            agent_id,
            LockedField::MemoryEntry,
        ))?);
    }
    let deleted_count = MEMORY_MANAGER_SERVICE
        .delete_many(user_id, &input.entry_ids, agent_id)
        .await?;
    let mut result = json!({ "success": true, "deletedCount": deleted_count });
    if let Some(reason) = input.reason {
        result["reason"] = Value::String(reason);
    }
    Ok(result)
}

/// memory_search, memory_write, memory_delete. The search emits `memory searched`.
pub fn get_memory_tools(user_id: &str, agent_id: &str) -> ToolSet {
    let mut tools = ToolSet::new();
    let (user, agent) = (user_id.to_string(), agent_id.to_string());
    tools.insert(
        "memory_search".to_string(),
        tool(Tool {
            description: Some(MEMORY_SEARCH_DESCRIPTION.to_string()),
            input_schema: zod_schema(memory_search_input_schema()),
            execute: Some(execute_fn(move |input, _| {
                let (user, agent) = (user.clone(), agent.clone());
                async move { run_memory_search(&user, &agent, input).await }
            })),
            ..Default::default()
        }),
    );
    let (user, agent) = (user_id.to_string(), agent_id.to_string());
    tools.insert(
        "memory_write".to_string(),
        tool(Tool {
            description: Some(MEMORY_WRITE_DESCRIPTION.to_string()),
            input_schema: zod_schema(memory_write_input_schema()),
            execute: Some(execute_fn(move |input, _| {
                let (user, agent) = (user.clone(), agent.clone());
                async move { run_memory_write(&user, &agent, input).await }
            })),
            ..Default::default()
        }),
    );
    let (user, agent) = (user_id.to_string(), agent_id.to_string());
    tools.insert(
        "memory_delete".to_string(),
        tool(Tool {
            description: Some(MEMORY_DELETE_DESCRIPTION.to_string()),
            input_schema: zod_schema(memory_delete_input_schema()),
            execute: Some(execute_fn(move |input, _| {
                let (user, agent) = (user.clone(), agent.clone());
                async move { run_memory_delete(&user, &agent, input).await }
            })),
            ..Default::default()
        }),
    );
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn the_definitions_match_the_typescript_runtime() {
        let tools = get_memory_tools("user-1", "agent-1");
        crate::tools::schema_fixture::assert_matches_fixture("memory", &tools);
    }

    #[test]
    fn exposes_search_write_and_delete() {
        let tools = get_memory_tools("user-123", "test-agent-id");
        let names: Vec<&str> = tools.keys().map(String::as_str).collect();
        assert_eq!(names, ["memory_search", "memory_write", "memory_delete"]);
    }

    #[test]
    fn searches_the_whole_store_when_no_window_is_given() {
        assert_eq!(parse_window(None, None), Ok(SearchWindow::default()));
    }

    // "What did you record last Tuesday" is one date on both bounds.
    #[test]
    fn reads_a_bare_date_as_that_whole_day_in_utc() {
        let window = parse_window(Some("2026-10-06"), Some("2026-10-06")).unwrap();
        assert_eq!(window.since, Some(at("2026-10-06T00:00:00.000Z")));
        assert_eq!(window.until, Some(at("2026-10-06T23:59:59.999Z")));
    }

    #[test]
    fn takes_a_date_time_with_an_offset_as_that_instant() {
        let window = parse_window(Some("2026-10-06T14:30:00+03:00"), None).unwrap();
        assert_eq!(window.since, Some(at("2026-10-06T11:30:00Z")));
    }

    // A date the parser would roll over (February 30th) or read in the host's zone
    // (no offset) is refused rather than searched.
    #[test]
    fn refuses_a_malformed_bound_and_names_it() {
        for (bound, value) in [
            ("since", "last tuesday"),
            ("since", "2026-02-30"),
            ("until", "2026-10-06T14:30:00"),
            ("until", "Oct 6"),
        ] {
            let result = if bound == "since" {
                parse_window(Some(value), None)
            } else {
                parse_window(None, Some(value))
            };
            let error = result.unwrap_err();
            assert!(
                error.contains(&format!(
                    "{bound} is not a date or a date-time: \"{value}\""
                )),
                "{error}"
            );
            assert!(error.ends_with(BOUND_FORMAT));
        }
    }

    #[test]
    fn refuses_a_window_that_starts_after_it_ends() {
        assert_eq!(
            parse_window(Some("2026-10-07"), Some("2026-10-06")),
            Err("since (2026-10-07) is after until (2026-10-06).".to_string())
        );
    }

    #[test]
    fn reads_a_leap_day_only_in_a_leap_year() {
        assert!(parse_bound(Bound::Since, "2028-02-29").is_some());
        assert!(parse_bound(Bound::Since, "2026-02-29").is_none());
        assert!(parse_bound(Bound::Since, "2026-10-06T14:30Z").is_none());
        assert_eq!(
            parse_bound(Bound::Since, "2026-10-06T14:30:00.1239Z"),
            Some(at("2026-10-06T14:30:00.123Z"))
        );
    }

    #[test]
    fn reports_the_search_shape_without_the_query() {
        let input = MemorySearchInput {
            query: Some("deploys".to_string()),
            until: Some("2026-10-06".to_string()),
            sort: Some(MemorySort::Newest),
            ..Default::default()
        };
        let props = search_event("test-agent-id", &input);
        let expected: Vec<(&str, &str)> = vec![
            ("agent.id", "test-agent-id"),
            ("memory.search.has_query", "true"),
            ("memory.search.has_window", "true"),
            ("memory.search.sort", "newest"),
        ];
        let actual: Vec<(&str, &str)> = props
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn reports_a_blank_query_as_none_and_relevance_by_default() {
        let input = MemorySearchInput {
            query: Some("  ".to_string()),
            since: Some("last tuesday".to_string()),
            ..Default::default()
        };
        let props = search_event("a", &input);
        assert_eq!(props["memory.search.has_query"], "false");
        assert_eq!(props["memory.search.has_window"], "true");
        assert_eq!(props["memory.search.sort"], "relevance");
    }
}
