//! The conversation search tool: finds what was said in the agent's conversations,
//! on every surface, and reads one conversation, the part a compaction summary
//! replaced included.
//!
//! A read returns the messages as they are stored, tool results included; a search
//! matches what the index holds (`lib::message_search_index`), and a search of one
//! conversation also its tool results. A run reaches the conversations its
//! [`SearchScope`] allows.

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::ai::{Tool, ToolSet, execute_fn, tool, zod_schema};
use crate::db::models::MessageRole;
use crate::lib::tool_output_store::tool_output_path;
use crate::services::conversation_search_service::{
    CONVERSATION_SEARCH_SERVICE, HistoryMessage, HistoryPage, SearchOptions, SearchOutcome,
    SearchScope,
};
use crate::support::iso;
use crate::support::js::{len16, slice16, stringify, stringify_pretty, truthy};

pub const CONVERSATION_SEARCH_TOOL_NAME: &str = "search_conversations";
const CONVERSATION_SEARCH_DESCRIPTION: &str = "Search your conversations on every surface for what was said in them, or read one conversation. Use it when the user refers to something said in another conversation, or when this conversation's summary leaves out an exact detail: a command, an error, a value, what the user said word for word. A search takes a short query: a few distinctive keywords, not documents, code or long passages. It matches the words of messages, your replies and the inputs of your tool calls; tool results only in a search with a conversation_id. Each match gives its conversation_id and the message's position in that conversation. To read around a match, give that conversation_id and an offset a few positions before it, without a query; a smaller offset reads earlier messages. Give conversation_id and position to read one message in full, with its tool results. The conversation_id \"current\" is this conversation, including the part its summary replaced.";

/// The conversation id that names the conversation the tool runs in.
pub const CURRENT_CONVERSATION: &str = "current";

const DEFAULT_RESULTS: i64 = 5;
const MAX_RESULTS: i64 = 10;

const PAGE_SIZE: i64 = 20;

/// The text a page may hold, under the 30,000-character tool budget: a page cut by
/// that budget would hide messages its next offset skips.
const PAGE_CHARS: usize = 20_000;

/// Each message text, tool input and tool result in a page is cut to this many
/// characters, so every page fits the budget. A read of one message by position is
/// cut by `PAGE_CHARS` alone.
const OUTPUT_CHARS: usize = 2_000;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConversationSearchInput {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub max_results: Option<i64>,
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub offset: Option<i64>,
    #[serde(default)]
    pub position: Option<i64>,
    #[serde(default)]
    pub start: Option<i64>,
}

fn conversation_search_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "query": {
                "description": "A few distinctive keywords to search for. Without it, conversation_id names the conversation to read.",
                "type": "string",
                "minLength": 1
            },
            "conversation_id": {
                "description": "The conversation to search in or to read: an id a match gave, or \"current\" for this conversation. Without it, a query searches every conversation.",
                "type": "string",
                "minLength": 1
            },
            "max_results": {
                "description": "How many matches to return, 1 to 10. Default 5.",
                "type": "integer",
                "minimum": 1,
                "maximum": 10
            },
            "after": {
                "description": "With a query: only messages from this time on. An ISO 8601 date or time, or a span back from now such as 24h, 7d or 2w.",
                "type": "string"
            },
            "before": {
                "description": "With a query: only messages before this time. An ISO 8601 date or time, or a span back from now such as 24h, 7d or 2w.",
                "type": "string"
            },
            "offset": {
                "description": "With conversation_id and no query: the position of the first message to read. Default 0.",
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991_i64
            },
            "position": {
                "description": "With conversation_id and no query: read the message at this position in full, uncut.",
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991_i64
            },
            "start": {
                "description": "With position: the character to start from, for the next part of a long message. Default 0.",
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991_i64
            }
        },
        "additionalProperties": false
    })
}

/// What the tool is bound to.
#[derive(Debug, Clone, Default)]
pub struct ConversationSearchToolsInput {
    pub agent_id: String,
    pub user_id: String,
    /// The conversation the run belongs to, which `"current"` names.
    pub thread_id: Option<String>,
    pub workspace_root: Option<String>,
    /// The conversations the run may search and read.
    pub scope: SearchScope,
}

pub fn get_conversation_search_tools(input: ConversationSearchToolsInput) -> ToolSet {
    let mut tools = ToolSet::new();
    tools.insert(
        CONVERSATION_SEARCH_TOOL_NAME.to_string(),
        tool(Tool {
            description: Some(CONVERSATION_SEARCH_DESCRIPTION.to_string()),
            input_schema: zod_schema(conversation_search_input_schema()),
            execute: Some(execute_fn(move |args, _| {
                let bound = input.clone();
                async move {
                    let args: ConversationSearchInput = serde_json::from_value(args)?;
                    run_conversation_search(args, &bound, Utc::now()).await
                }
            })),
            ..Default::default()
        }),
    );
    tools
}

pub(crate) async fn run_conversation_search(
    input: ConversationSearchInput,
    bound: &ConversationSearchToolsInput,
    now: DateTime<Utc>,
) -> anyhow::Result<Value> {
    let no_conversation = || json!({ "note": "This run has no conversation of its own." });
    let conversation = match input.conversation_id.as_deref() {
        // A run that may read only its own conversation searches that one.
        None if bound.scope == SearchScope::Current => match &bound.thread_id {
            Some(thread_id) => Some(thread_id.clone()),
            None => return Ok(no_conversation()),
        },
        None => None,
        Some(CURRENT_CONVERSATION) => match &bound.thread_id {
            Some(thread_id) => Some(thread_id.clone()),
            None => return Ok(no_conversation()),
        },
        Some(id) => Some(id.to_string()),
    };
    let current = bound.thread_id.as_deref();
    // Saved tool outputs are in the store of the workspace the conversation's runs used.
    let mut root = bound.workspace_root.clone();
    if let Some(id) = &conversation {
        let Some(found) = CONVERSATION_SEARCH_SERVICE
            .conversation(&bound.agent_id, id, &bound.scope, current)
            .await?
        else {
            return Ok(json!({ "note": format!("No conversation has the id {id}.") }));
        };
        if current != Some(id.as_str()) {
            root = found.workspace_root;
        }
    }
    let query = input
        .query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty());

    let Some(query) = query else {
        let Some(thread_id) = conversation else {
            return Ok(json!({
                "note": "Give a query to search, or a conversation_id to read."
            }));
        };
        let root = root.as_deref();
        if let Some(position) = input.position {
            let message = CONVERSATION_SEARCH_SERVICE
                .get_history_message(&thread_id, position)
                .await?;
            return Ok(message_part(
                message.as_ref(),
                position,
                input.start.unwrap_or(0),
                root,
            ));
        }
        let offset = input.offset.unwrap_or(0);
        let page = CONVERSATION_SEARCH_SERVICE
            .list_history(&thread_id, offset, PAGE_SIZE)
            .await?;
        return Ok(page_result(&page, offset, root));
    };

    let after_ms = match input.after.as_deref().map(|text| parse_time(text, now)) {
        Some(None) => return Ok(time_note("after")),
        bound_time => bound_time.flatten(),
    };
    let before_ms = match input.before.as_deref().map(|text| parse_time(text, now)) {
        Some(None) => return Ok(time_note("before")),
        bound_time => bound_time.flatten(),
    };
    let outcome = CONVERSATION_SEARCH_SERVICE
        .search(SearchOptions {
            query: query.to_string(),
            agent_id: bound.agent_id.clone(),
            channel_id: match &bound.scope {
                SearchScope::Channel(channel) => Some(channel.clone()),
                _ => None,
            },
            current_thread_id: bound.thread_id.clone(),
            thread_id: conversation,
            after_ms,
            before_ms,
            limit: input
                .max_results
                .unwrap_or(DEFAULT_RESULTS)
                .clamp(1, MAX_RESULTS),
            user_id: Some(bound.user_id.clone()).filter(|id| !id.is_empty()),
        })
        .await?;
    Ok(search_result(&outcome, bound.thread_id.as_deref()))
}

fn time_note(field: &str) -> Value {
    json!({
        "note": format!("{field}: give an ISO 8601 date or time, or a span such as 24h, 7d or 2w.")
    })
}

/// Epoch milliseconds of an ISO 8601 date (midnight UTC), an RFC 3339 time, or a
/// span back from `now` (`24h`, `7d`, `2w`). `None` when the text is none of those.
fn parse_time(text: &str, now: DateTime<Utc>) -> Option<i64> {
    let text = text.trim();
    if let Ok(time) = DateTime::parse_from_rfc3339(text) {
        return Some(time.timestamp_millis());
    }
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
    }
    let unit = text.chars().last()?;
    let amount: i64 = text[..text.len() - unit.len_utf8()].trim().parse().ok()?;
    let span = match unit.to_ascii_lowercase() {
        'h' => Duration::try_hours(amount)?,
        'd' => Duration::try_days(amount)?,
        'w' => Duration::try_weeks(amount)?,
        _ => return None,
    };
    Some((now - span).timestamp_millis())
}

fn search_result(outcome: &SearchOutcome, current: Option<&str>) -> Value {
    if outcome.no_words {
        return json!({ "matches": [], "note": "The query holds no word to search for." });
    }
    if outcome.matches.is_empty() {
        return json!({ "matches": [], "note": "No message matches." });
    }
    let matches: Vec<Value> = outcome
        .matches
        .iter()
        .map(|found| {
            let mut entry = Map::new();
            entry.insert("conversationId".to_string(), json!(found.thread_id));
            if let Some(title) = &found.conversation_title {
                entry.insert("conversation".to_string(), json!(title));
            }
            if current == Some(found.thread_id.as_str()) {
                entry.insert("current".to_string(), json!(true));
            }
            entry.insert("position".to_string(), json!(found.message.position));
            author(&mut entry, &found.message);
            entry.insert("at".to_string(), json!(iso(&found.message.created_at)));
            entry.insert("text".to_string(), json!(found.excerpt));
            Value::Object(entry)
        })
        .collect();
    let mut result = json!({ "matches": matches });
    if outcome.any_word {
        result["note"] = json!("No message holds every word; these hold at least one.");
    }
    result
}

/// A page as the tool returns it: the entries that fit `PAGE_CHARS`, and the
/// offset of the first one left out when any are.
fn page_result(page: &HistoryPage, offset: i64, workspace_root: Option<&str>) -> Value {
    if page.messages.is_empty() {
        let note = if offset > 0 {
            "No more messages."
        } else {
            "The conversation has no messages."
        };
        return json!({ "messages": [], "note": note });
    }
    let mut entries: Vec<Value> = Vec::new();
    let mut chars = 0usize;
    for message in &page.messages {
        let entry = to_entry(message, workspace_root);
        chars += len16(&stringify(&entry));
        if !entries.is_empty() && chars > PAGE_CHARS {
            break;
        }
        entries.push(entry);
    }
    let more = page.more || entries.len() < page.messages.len();
    let shown = entries.len() as i64;
    let mut result = json!({ "messages": entries });
    if more {
        result["nextOffset"] = json!(offset + shown);
    }
    result
}

/// One message as one text, every part uncut, read `PAGE_CHARS` at a time from `start`.
fn message_part(
    message: Option<&HistoryMessage>,
    position: i64,
    start: i64,
    workspace_root: Option<&str>,
) -> Value {
    let Some(message) = message else {
        return json!({ "note": format!("No message at position {position}.") });
    };
    let text = full_text(message, workspace_root);
    let total = len16(&text);
    let from = start.max(0) as usize;
    let part = slice16(&text, from, from + PAGE_CHARS);
    let next = start + len16(&part) as i64;
    let mut entry = Map::new();
    entry.insert("position".to_string(), json!(position));
    author(&mut entry, message);
    entry.insert("at".to_string(), json!(iso(&message.created_at)));
    entry.insert("characters".to_string(), json!(total));
    entry.insert("start".to_string(), json!(start));
    entry.insert("text".to_string(), json!(part));
    if next < total as i64 {
        entry.insert("nextStart".to_string(), json!(next));
    }
    Value::Object(entry)
}

/// `from`, and `name` when the message names the person or agent who wrote it.
/// A user row that is an internal step holds context the runtime added, such as
/// recalled memories.
fn author(entry: &mut Map<String, Value>, message: &HistoryMessage) {
    let from = match message.role {
        MessageRole::User if message.internal_step => "context",
        MessageRole::User => "user",
        MessageRole::Agent => "you",
        MessageRole::System => "system",
    };
    entry.insert("from".to_string(), json!(from));
    if message.role == MessageRole::User
        && let Some(name) = message
            .sender_name
            .as_deref()
            .filter(|name| !name.is_empty())
    {
        entry.insert("name".to_string(), json!(name));
    }
}

/// A value as a template literal writes it: `undefined` for a missing one.
fn template_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(n)) => n
            .as_f64()
            .map_or_else(|| n.to_string(), crate::support::js::number_text),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => template_text(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// The stored tool calls of a message, when the column holds a list.
fn tool_calls(message: &HistoryMessage) -> &[Value] {
    match &message.tool_calls {
        Some(Value::Array(calls)) => calls,
        _ => &[],
    }
}

/// The field of a stored call; a call that is not an object has none.
fn field<'a>(call: &'a Value, name: &str) -> Option<&'a Value> {
    call.as_object().and_then(|c| c.get(name))
}

/// The id the whole result of a cut tool output was saved under, when it was.
fn spill_id(call: &Value) -> Option<String> {
    let id = field(call, "truncated").and_then(|t| t.get("spillId"))?;
    if !truthy(id) {
        return None;
    }
    Some(template_text(Some(id)))
}

fn full_text(message: &HistoryMessage, workspace_root: Option<&str>) -> String {
    let mut parts = vec![message.content.clone()];
    for call in tool_calls(message) {
        let input = match field(call, "input") {
            Some(Value::String(text)) => text.clone(),
            Some(value) => stringify(value),
            None => "null".to_string(),
        };
        let output = match field(call, "output") {
            Some(Value::String(text)) => text.clone(),
            Some(value) => stringify_pretty(value),
            None => "null".to_string(),
        };
        parts.push(format!(
            "[Tool call: {}]",
            template_text(field(call, "tool"))
        ));
        parts.push(format!("[Input]\n{input}"));
        parts.push(format!("[Output]\n{output}"));
        if let Some(id) = spill_id(call) {
            parts.push(format!(
                "[Saved whole result: {}]",
                tool_output_path(&id, workspace_root)
            ));
        }
    }
    parts.join("\n\n")
}

fn to_entry(message: &HistoryMessage, workspace_root: Option<&str>) -> Value {
    let position = message.position;
    let mut entry = Map::new();
    entry.insert("position".to_string(), json!(position));
    author(&mut entry, message);
    entry.insert("at".to_string(), json!(iso(&message.created_at)));
    entry.insert(
        "text".to_string(),
        clip(&Value::String(message.content.clone()), position),
    );
    let calls = tool_calls(message);
    if !calls.is_empty() {
        let listed: Vec<Value> = calls
            .iter()
            .map(|call| {
                let mut out = Map::new();
                if let Some(name) = field(call, "tool") {
                    out.insert("tool".to_string(), name.clone());
                }
                match field(call, "input") {
                    Some(input @ Value::String(_)) => {
                        out.insert("input".to_string(), clip(input, position));
                    }
                    Some(input) => {
                        out.insert("input".to_string(), clip_json(input, position));
                    }
                    None => {}
                }
                if let Some(output) = field(call, "output") {
                    out.insert("output".to_string(), clip(output, position));
                }
                // The saved whole result, which the shell reads; its notice in `output` may be cut away.
                if let Some(id) = spill_id(call) {
                    out.insert(
                        "savedAt".to_string(),
                        json!(tool_output_path(&id, workspace_root)),
                    );
                }
                Value::Object(out)
            })
            .collect();
        entry.insert("toolCalls".to_string(), Value::Array(listed));
    }
    Value::Object(entry)
}

/// A tool input given as an object, cut as text when its JSON is long.
fn clip_json(input: &Value, position: i64) -> Value {
    let json = stringify(input);
    if len16(&json) <= OUTPUT_CHARS {
        return input.clone();
    }
    clip(&Value::String(json), position)
}

/// The first `OUTPUT_CHARS` of a long text, with `[Cut: 2000 of <length> characters
/// shown. Call with position <p> to read this message in full.]` after. Lengths are
/// UTF-16 units.
fn clip(output: &Value, position: i64) -> Value {
    let Value::String(text) = output else {
        return output.clone();
    };
    let length = len16(text);
    if length <= OUTPUT_CHARS {
        return output.clone();
    }
    let shown = slice16(text, 0, OUTPUT_CHARS);
    Value::String(format!(
        "{shown}\n[Cut: {OUTPUT_CHARS} of {length} characters shown. Call with position {position} to read this message in full.]"
    ))
}

#[cfg(test)]
#[path = "conversation_search_tests.rs"]
mod tests;
