//! The compacted-history tool — reads the messages a compaction summary replaced.
//!
//! A summary keeps what a later turn most likely needs; this tool returns the exact
//! words when it does not. The rows stay in the database after a compaction, marked
//! `isCompacted`, so nothing is lost, only out of the context.
//!
//! Bound to the turn's thread: the model cannot name another conversation.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::ai::{Tool, ToolSet, execute_fn, tool, zod_schema};
use crate::db::models::MessageRole;
use crate::lib::tool_output_store::tool_output_path;
use crate::services::conversation_service::{
    CONVERSATION_SERVICE, CompactedListOptions, CompactedMessage, CompactedPage,
};
use crate::support::iso;
use crate::support::js::{len16, slice16, stringify, stringify_pretty, truthy};

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
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "query": {
                "description": "Return only the messages whose text or tool calls contain this, ignoring case.",
                "type": "string",
                "minLength": 1
            },
            "offset": {
                "description": "How many messages to skip, for the next page. Without a query this is the position of the first message. Default 0.",
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991_i64
            },
            "position": {
                "description": "Read the message at this position in full, uncut. Ignores query and offset.",
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

/// A page of the compacted messages (`{ messages, nextOffset? }`, or
/// `{ messages: [], note }`), or one message in full when `position` is given.
pub async fn run_read_compacted_history(
    input: CompactedHistoryInput,
    thread_id: &str,
    workspace_root: Option<&str>,
) -> anyhow::Result<Value> {
    let offset = input.offset.unwrap_or(0);
    let start = input.start.unwrap_or(0);
    if let Some(position) = input.position {
        let message = CONVERSATION_SERVICE
            .get_compacted_message(thread_id, position)
            .await?;
        return Ok(message_part(
            message.as_ref(),
            position,
            start,
            workspace_root,
        ));
    }
    let page = CONVERSATION_SERVICE
        .list_compacted_messages(
            thread_id,
            CompactedListOptions {
                query: input.query.clone(),
                offset,
                limit: PAGE_SIZE,
            },
        )
        .await?;
    Ok(page_result(
        &page,
        input.query.as_deref(),
        offset,
        workspace_root,
    ))
}

/// A page as the tool returns it: the entries that fit `PAGE_CHARS`, and the
/// offset of the first one left out when any are.
fn page_result(
    page: &CompactedPage,
    query: Option<&str>,
    offset: i64,
    workspace_root: Option<&str>,
) -> Value {
    if page.messages.is_empty() {
        let note = if offset > 0 {
            "No more messages."
        } else {
            "No earlier message matches."
        };
        return json!({ "messages": [], "note": note });
    }
    let mut entries: Vec<Value> = Vec::new();
    let mut chars = 0usize;
    for message in &page.messages {
        let entry = to_entry(message, query, workspace_root);
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

/// `read_compacted_history`, bound to the thread.
pub fn get_conversation_history_tools(thread_id: &str, workspace_root: Option<&str>) -> ToolSet {
    let thread = thread_id.to_string();
    let root = workspace_root.map(str::to_string);
    let mut tools = ToolSet::new();
    tools.insert(
        COMPACTED_HISTORY_TOOL_NAME.to_string(),
        tool(Tool {
            description: Some(COMPACTED_HISTORY_DESCRIPTION.to_string()),
            input_schema: zod_schema(compacted_history_input_schema()),
            execute: Some(execute_fn(move |input, _| {
                let (thread, root) = (thread.clone(), root.clone());
                async move {
                    let input: CompactedHistoryInput = serde_json::from_value(input)?;
                    run_read_compacted_history(input, &thread, root.as_deref()).await
                }
            })),
            ..Default::default()
        }),
    );
    tools
}

/// One message as one text, every part uncut, read `PAGE_CHARS` at a time from `start`.
fn message_part(
    message: Option<&CompactedMessage>,
    position: i64,
    start: i64,
    workspace_root: Option<&str>,
) -> Value {
    let Some(message) = message else {
        return json!({ "note": format!("No earlier message at position {position}.") });
    };
    let text = full_text(message, workspace_root);
    let total = len16(&text);
    let from = start.max(0) as usize;
    let part = slice16(&text, from, from + PAGE_CHARS);
    let next = start + len16(&part) as i64;
    let mut result = json!({
        "position": position,
        "from": author_of(message),
        "at": iso(&message.created_at),
        "characters": total,
        "start": start,
        "text": part,
    });
    if next < total as i64 {
        result["nextStart"] = json!(next);
    }
    result
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
fn tool_calls(message: &CompactedMessage) -> &[Value] {
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

fn full_text(message: &CompactedMessage, workspace_root: Option<&str>) -> String {
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

/// A user row that is an internal step holds context the runtime added, such as recalled memories.
fn author_of(message: &CompactedMessage) -> &'static str {
    match message.role {
        MessageRole::User if message.internal_step => "context",
        MessageRole::User => "user",
        MessageRole::Agent => "you",
        _ => "system",
    }
}

fn to_entry(
    message: &CompactedMessage,
    query: Option<&str>,
    workspace_root: Option<&str>,
) -> Value {
    let position = message.position;
    let mut entry = Map::new();
    entry.insert("position".to_string(), json!(position));
    entry.insert("from".to_string(), json!(author_of(message)));
    entry.insert("at".to_string(), json!(iso(&message.created_at)));
    entry.insert(
        "text".to_string(),
        clip(&Value::String(message.content.clone()), query, position),
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
                        out.insert("input".to_string(), clip(input, query, position));
                    }
                    Some(input) => {
                        out.insert("input".to_string(), clip_json(input, query, position));
                    }
                    None => {}
                }
                if let Some(output) = field(call, "output") {
                    out.insert("output".to_string(), clip(output, query, position));
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

/// A tool input given as an object, cut as text when its JSON is long, around the query as JSON writes it.
fn clip_json(input: &Value, query: Option<&str>, position: i64) -> Value {
    let json = stringify(input);
    if len16(&json) <= OUTPUT_CHARS {
        return input.clone();
    }
    let escaped = query.map(|q| {
        let quoted = stringify(&Value::String(q.to_string()));
        slice16(&quoted, 1, len16(&quoted) - 1)
    });
    clip(&Value::String(json), escaped.as_deref(), position)
}

/// The first `OUTPUT_CHARS` of a long text, or the window around the query's first
/// match in it, with `[From character <n>.]` before a window that does not start
/// at 0 and `[Cut: 2000 of <length> characters shown. Call with position <p> to
/// read this message in full.]` after. Lengths and positions are UTF-16 units.
fn clip(output: &Value, query: Option<&str>, position: i64) -> Value {
    let Value::String(text) = output else {
        return output.clone();
    };
    let length = len16(text);
    if length <= OUTPUT_CHARS {
        return output.clone();
    }
    let found = query.filter(|q| !q.is_empty()).and_then(|q| {
        let haystack = text.to_lowercase();
        haystack
            .find(&q.to_lowercase())
            .map(|byte| len16(&haystack[..byte]))
    });
    let start = match found {
        Some(at) if at > OUTPUT_CHARS / 2 => (at - OUTPUT_CHARS / 4).min(length - OUTPUT_CHARS),
        _ => 0,
    };
    let shown = slice16(text, start, start + OUTPUT_CHARS);
    let from = if start > 0 {
        format!("[From character {start}.]\n")
    } else {
        String::new()
    };
    Value::String(format!(
        "{from}{shown}\n[Cut: {OUTPUT_CHARS} of {length} characters shown. Call with position {position} to read this message in full.]"
    ))
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, Utc};

    use super::*;

    fn at() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-01T09:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn message(
        role: MessageRole,
        content: &str,
        tool_calls: Option<Value>,
        position: i64,
    ) -> CompactedMessage {
        CompactedMessage {
            id: format!("m-{position}"),
            role,
            content: content.to_string(),
            tool_calls,
            internal_step: false,
            created_at: at(),
            position,
        }
    }

    fn page(messages: Vec<CompactedMessage>, more: bool) -> CompactedPage {
        CompactedPage { messages, more }
    }

    #[test]
    fn the_definition_matches_the_typescript_runtime() {
        let tools = get_conversation_history_tools("thread-1", None);
        crate::tools::schema_fixture::assert_matches_fixture("conversation-history", &tools);
    }

    #[test]
    fn reads_one_page_with_its_tool_calls() {
        let listed = page(
            vec![
                message(MessageRole::User, "Deploy to staging.", None, 31),
                message(
                    MessageRole::Agent,
                    "It failed.",
                    Some(json!([{
                        "tool": "shell_exec",
                        "input": { "command": "kubectl get pods" },
                        "output": "CrashLoopBackOff",
                        "rendered": true
                    }])),
                    32,
                ),
            ],
            true,
        );

        let result = page_result(&listed, Some("crash"), 20, None);

        assert_eq!(
            result,
            json!({
                "messages": [
                    { "position": 31, "from": "user", "at": "2026-10-01T09:00:00.000Z", "text": "Deploy to staging." },
                    {
                        "position": 32,
                        "from": "you",
                        "at": "2026-10-01T09:00:00.000Z",
                        "text": "It failed.",
                        "toolCalls": [{ "tool": "shell_exec", "input": { "command": "kubectl get pods" }, "output": "CrashLoopBackOff" }]
                    }
                ],
                "nextOffset": 22
            })
        );
    }

    #[test]
    fn labels_a_recalled_memory_block_as_context() {
        let mut recalled = message(MessageRole::User, "<recalled-memories>", None, 0);
        recalled.internal_step = true;

        let result = page_result(&page(vec![recalled], false), None, 0, None);

        assert_eq!(result["messages"][0]["from"], "context");
        assert!(result.get("nextOffset").is_none());
    }

    #[test]
    fn stops_a_page_before_the_tool_budget_and_points_to_the_first_message_left_out() {
        let big = "x".repeat(1_800);
        let messages = (0..20)
            .map(|i| {
                message(
                    MessageRole::Agent,
                    "step",
                    Some(json!([{ "tool": "shell_exec", "input": {}, "output": big }])),
                    i,
                )
            })
            .collect();

        let result = page_result(&page(messages, false), None, 0, None);
        let shown = result["messages"].as_array().unwrap().len();

        assert!(shown < 20);
        assert!(len16(&stringify(&result["messages"])) <= 20_000);
        assert_eq!(result["nextOffset"], json!(shown));
    }

    #[test]
    fn cuts_a_long_message_text_and_a_long_tool_input_too() {
        let long = message(
            MessageRole::Agent,
            &"z".repeat(40_000),
            Some(json!([{
                "tool": "shell_write",
                "input": { "path": "a", "content": "w".repeat(40_000) },
                "output": "ok"
            }])),
            0,
        );

        let result = page_result(&page(vec![long], false), None, 0, None);

        assert!(len16(&stringify(&result)) < 6_000);
    }

    #[test]
    fn cuts_a_long_tool_result_inside_a_page() {
        let long = message(
            MessageRole::Agent,
            "",
            Some(json!([{ "tool": "t", "output": "y".repeat(5_000) }])),
            7,
        );

        let result = page_result(&page(vec![long], false), None, 0, None);

        assert_eq!(
            result["messages"][0]["toolCalls"][0]["output"],
            json!(format!(
                "{}\n[Cut: 2000 of 5000 characters shown. Call with position 7 to read this message in full.]",
                "y".repeat(2000)
            ))
        );
    }

    #[test]
    fn shows_the_window_around_the_querys_match() {
        let output = format!(
            "{} OOMKilled pod-7 {}",
            "a".repeat(20_000),
            "b".repeat(10_000)
        );

        let cut = clip(&json!(output), Some("oomkilled"), 3);
        let cut = cut.as_str().unwrap();

        assert!(cut.contains("OOMKilled pod-7"));
        assert!(cut.starts_with("[From character 19501.]\n"));
        assert!(cut.ends_with("Call with position 3 to read this message in full.]"));
    }

    #[test]
    fn cuts_a_long_tool_input_around_a_query_that_holds_quotes() {
        let content = format!(
            "{}say \"deploy-7f3a\" now{}",
            "x".repeat(5_000),
            "y".repeat(5_000)
        );
        let wrote = message(
            MessageRole::Agent,
            "wrote it",
            Some(
                json!([{ "tool": "shell_write", "input": { "path": "a", "content": content }, "output": "ok" }]),
            ),
            0,
        );

        let result = page_result(&page(vec![wrote], false), Some("\"deploy-7f3a\""), 0, None);
        let input = result["messages"][0]["toolCalls"][0]["input"]
            .as_str()
            .unwrap();

        assert!(input.contains("\\\"deploy-7f3a\\\""));
        assert!(input.contains("to read this message in full"));
    }

    #[test]
    fn reads_one_message_in_full_a_page_at_a_time() {
        let output = "z".repeat(30_000);
        let build = message(
            MessageRole::Agent,
            "Ran the build.",
            Some(
                json!([{ "tool": "shell_exec", "input": "{\"command\":\"make\"}", "output": output }]),
            ),
            12,
        );

        let first = message_part(Some(&build), 12, 0, None);
        assert_eq!(first["position"], 12);
        assert_eq!(first["from"], "you");
        assert_eq!(first["start"], 0);
        assert_eq!(first["nextStart"], 20_000);
        assert!(
            first["text"]
                .as_str()
                .unwrap()
                .starts_with("Ran the build.\n\n[Tool call: shell_exec]\n\n[Input]\n{\"command\":\"make\"}\n\n[Output]\n")
        );

        let second = message_part(Some(&build), 12, 20_000, None);
        let total = first["characters"].as_u64().unwrap() as usize;
        assert_eq!(second["start"], 20_000);
        assert_eq!(second["characters"], json!(total));
        assert!(second.get("nextStart").is_none());
        assert_eq!(
            len16(first["text"].as_str().unwrap()) + len16(second["text"].as_str().unwrap()),
            total
        );
    }

    #[test]
    fn says_when_no_message_has_the_position() {
        assert_eq!(
            message_part(None, 99, 0, None),
            json!({ "note": "No earlier message at position 99." })
        );
    }

    #[test]
    fn says_when_nothing_matches() {
        assert_eq!(
            page_result(&page(vec![], false), Some("nothing"), 0, None),
            json!({ "messages": [], "note": "No earlier message matches." })
        );
        assert_eq!(
            page_result(&page(vec![], false), None, 20, None),
            json!({ "messages": [], "note": "No more messages." })
        );
    }

    #[test]
    fn writes_a_missing_tool_name_as_javascript_does() {
        let unnamed = message(MessageRole::Agent, "x", Some(json!([{ "output": 3 }])), 0);
        assert_eq!(
            full_text(&unnamed, None),
            "x\n\n[Tool call: undefined]\n\n[Input]\nnull\n\n[Output]\n3"
        );
    }
}
