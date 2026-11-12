//! The MCP messages the client reads, checked as the SDK's schemas check them.
//!
//! A schema parse writes its output with the schema's own keys first, in the
//! schema's order, then any other key in input order, and fills `isError` with
//! its default. A tool result is stored and replayed in that shape, so the
//! functions here keep it.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::ai::json::js_stringify;

pub const LATEST_PROTOCOL_VERSION: &str = "2026-07-28";
pub const LATEST_LEGACY_PROTOCOL_VERSION: &str = "2025-11-25";
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 5] = [
    LATEST_PROTOCOL_VERSION,
    LATEST_LEGACY_PROTOCOL_VERSION,
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
];

const JSONRPC_VERSION: &str = "2.0";

pub type JsonObject = Map<String, Value>;

/// Why a value does not match a schema.
#[derive(Debug, Clone)]
pub struct SchemaError {
    pub message: String,
}

impl std::fmt::Display for SchemaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SchemaError {}

type Checked<T> = Result<T, SchemaError>;

fn invalid(message: impl Into<String>) -> SchemaError {
    SchemaError {
        message: message.into(),
    }
}

/// The keys of `shape` that `input` has, in shape order, then every other key of
/// `input` in its order.
fn reorder(input: &JsonObject, shape: &[&str]) -> JsonObject {
    let mut out = JsonObject::new();
    for key in shape {
        if let Some(value) = input.get(*key) {
            out.insert((*key).to_string(), value.clone());
        }
    }
    for (key, value) in input {
        if !shape.contains(&key.as_str()) {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

fn object<'a>(value: &'a Value, what: &str) -> Checked<&'a JsonObject> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("Invalid input: expected object at {what}")))
}

fn optional_string(obj: &JsonObject, key: &str) -> Checked<Option<String>> {
    match obj.get(key) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(invalid(format!("Invalid input: expected string at {key}"))),
    }
}

fn required_string(obj: &JsonObject, key: &str) -> Checked<String> {
    optional_string(obj, key)?
        .ok_or_else(|| invalid(format!("Invalid input: expected string at {key}")))
}

fn optional_bool(obj: &JsonObject, key: &str) -> Checked<()> {
    match obj.get(key) {
        None | Some(Value::Bool(_)) => Ok(()),
        Some(_) => Err(invalid(format!("Invalid input: expected boolean at {key}"))),
    }
}

fn optional_object(obj: &JsonObject, key: &str) -> Checked<()> {
    match obj.get(key) {
        None | Some(Value::Object(_)) => Ok(()),
        Some(_) => Err(invalid(format!("Invalid input: expected object at {key}"))),
    }
}

/// A loose object whose listed fields are optional booleans.
fn optional_flags(obj: &JsonObject, key: &str, flags: &[&str]) -> Checked<()> {
    match obj.get(key) {
        None => Ok(()),
        Some(Value::Object(inner)) => flags.iter().try_for_each(|f| optional_bool(inner, f)),
        Some(_) => Err(invalid(format!("Invalid input: expected object at {key}"))),
    }
}

/// `z.number().int()`: a safe integer.
fn is_int(value: &Value) -> bool {
    match value {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.unsigned_abs() <= 9_007_199_254_740_991
            } else if let Some(f) = n.as_f64() {
                f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0
            } else {
                false
            }
        }
        _ => false,
    }
}

fn is_id(value: &Value) -> bool {
    value.is_string() || is_int(value)
}

/// `ResultSchema`: `_meta` an object and `resultType` a string, when present.
fn check_result_base(obj: &JsonObject) -> Checked<()> {
    optional_object(obj, "_meta")?;
    optional_string(obj, "resultType")?;
    Ok(())
}

fn check_params(obj: &JsonObject) -> Checked<()> {
    match obj.get("params") {
        None => Ok(()),
        Some(Value::Object(params)) => optional_object(params, "_meta"),
        Some(_) => Err(invalid("Invalid input: expected object at params")),
    }
}

fn only_keys(obj: &JsonObject, allowed: &[&str]) -> bool {
    obj.keys().all(|k| allowed.contains(&k.as_str()))
}

/// `validateJSONRPCMessage`: a request, a notification, a response or an error,
/// each with no other top-level key.
pub fn validate_jsonrpc_message(value: Value) -> anyhow::Result<Value> {
    let Some(obj) = value.as_object() else {
        return Err(invalid("Invalid input: expected a JSON-RPC message").into());
    };
    let version_ok = obj.get("jsonrpc") == Some(&json!(JSONRPC_VERSION));

    // Request.
    if version_ok
        && obj.get("id").is_some_and(is_id)
        && obj.get("method").is_some_and(Value::is_string)
        && check_params(obj).is_ok()
        && only_keys(obj, &["jsonrpc", "id", "method", "params"])
    {
        return Ok(Value::Object(reorder(
            obj,
            &["jsonrpc", "id", "method", "params"],
        )));
    }
    // Notification.
    if version_ok
        && obj.get("method").is_some_and(Value::is_string)
        && check_params(obj).is_ok()
        && only_keys(obj, &["jsonrpc", "method", "params"])
    {
        return Ok(Value::Object(reorder(
            obj,
            &["jsonrpc", "method", "params"],
        )));
    }
    // Response.
    if version_ok
        && obj.get("id").is_some_and(is_id)
        && only_keys(obj, &["jsonrpc", "id", "result"])
        && let Some(Value::Object(result)) = obj.get("result")
        && check_result_base(result).is_ok()
    {
        let mut out = JsonObject::new();
        out.insert("jsonrpc".into(), json!(JSONRPC_VERSION));
        out.insert("id".into(), obj["id"].clone());
        out.insert(
            "result".into(),
            Value::Object(reorder(result, &["_meta", "resultType"])),
        );
        return Ok(Value::Object(out));
    }
    // Error.
    if version_ok
        && obj.get("id").is_none_or(is_id)
        && only_keys(obj, &["jsonrpc", "id", "error"])
        && let Some(Value::Object(error)) = obj.get("error")
        && error.get("code").is_some_and(is_int)
        && error.get("message").is_some_and(Value::is_string)
    {
        let mut stripped = JsonObject::new();
        stripped.insert("code".into(), error["code"].clone());
        stripped.insert("message".into(), error["message"].clone());
        if let Some(data) = error.get("data") {
            stripped.insert("data".into(), data.clone());
        }
        let mut out = JsonObject::new();
        out.insert("jsonrpc".into(), json!(JSONRPC_VERSION));
        if let Some(id) = obj.get("id") {
            out.insert("id".into(), id.clone());
        }
        out.insert("error".into(), Value::Object(stripped));
        return Ok(Value::Object(out));
    }
    Err(invalid("Invalid input: expected a JSON-RPC message").into())
}

/// `parseJSONRPCMessage`: the text as JSON (a `JsonParseError` when it is not),
/// then checked as a JSON-RPC message.
pub fn parse_jsonrpc_message(text: &str) -> anyhow::Result<Value> {
    let value = crate::ai::json::parse_json(text)?;
    validate_jsonrpc_message(value)
}

/// `JSON.parse`: the value with integral doubles read as integers, or the
/// `SyntaxError` the parser reports.
pub fn json_parse(text: &str) -> anyhow::Result<Value> {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => Ok(crate::ai::json::normalize_numbers(value)),
        Err(_) => Err(match crate::ai::json::secure_json_parse(text) {
            Err(syntax) => anyhow::Error::new(syntax),
            Ok(_) => anyhow::anyhow!("Unexpected end of JSON input"),
        }),
    }
}

fn check_server_capabilities(value: &Value) -> Checked<()> {
    let caps = object(value, "capabilities")?;
    match caps.get("events") {
        None | Some(Value::Null) => {}
        Some(Value::Object(events)) => match events.get("listChanged") {
            None | Some(Value::Null) | Some(Value::Bool(_)) => {}
            Some(_) => return Err(invalid("Invalid input: expected boolean at listChanged")),
        },
        Some(_) => return Err(invalid("Invalid input: expected object at events")),
    }
    optional_object(caps, "experimental")?;
    optional_object(caps, "logging")?;
    optional_object(caps, "completions")?;
    optional_flags(caps, "prompts", &["listChanged"])?;
    optional_flags(caps, "resources", &["subscribe", "listChanged"])?;
    optional_flags(caps, "tools", &["listChanged"])?;
    optional_flags(caps, "elicitation", &["applyDefaults"])?;
    Ok(())
}

/// `InitializeResultSchema`.
pub fn parse_initialize_result(value: &Value) -> Checked<Value> {
    let obj = object(value, "result")?;
    check_result_base(obj)?;
    required_string(obj, "protocolVersion")?;
    check_server_capabilities(obj.get("capabilities").unwrap_or(&Value::Null))?;
    let info = object(obj.get("serverInfo").unwrap_or(&Value::Null), "serverInfo")?;
    required_string(info, "name")?;
    required_string(info, "version")?;
    optional_string(info, "title")?;
    optional_string(obj, "instructions")?;
    let mut out = reorder(
        obj,
        &[
            "_meta",
            "resultType",
            "protocolVersion",
            "capabilities",
            "serverInfo",
            "instructions",
        ],
    );
    out.insert(
        "serverInfo".into(),
        Value::Object(reorder(info, &["name", "version", "title"])),
    );
    Ok(Value::Object(out))
}

/// `DiscoverResultSchema`.
pub fn parse_discover_result(value: &Value) -> Checked<Value> {
    let obj = object(value, "result")?;
    check_result_base(obj)?;
    match obj.get("supportedVersions") {
        Some(Value::Array(items)) if items.iter().all(Value::is_string) => {}
        _ => {
            return Err(invalid(
                "Invalid input: expected array at supportedVersions",
            ));
        }
    }
    check_server_capabilities(obj.get("capabilities").unwrap_or(&Value::Null))?;
    optional_string(obj, "instructions")?;
    match obj.get("ttlMs") {
        None | Some(Value::Number(_)) => {}
        Some(_) => return Err(invalid("Invalid input: expected number at ttlMs")),
    }
    match obj.get("cacheScope") {
        None => {}
        Some(Value::String(s)) if s == "public" || s == "private" => {}
        Some(_) => return Err(invalid("Invalid input at cacheScope")),
    }
    Ok(Value::Object(reorder(
        obj,
        &[
            "_meta",
            "resultType",
            "supportedVersions",
            "capabilities",
            "instructions",
            "ttlMs",
            "cacheScope",
        ],
    )))
}

/// One tool the server lists.
#[derive(Debug, Clone, PartialEq)]
pub struct McpToolDefinition {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    /// The JSON Schema of the input, `type` and `properties` first.
    pub input_schema: JsonObject,
    pub annotations: Option<JsonObject>,
    pub meta: Option<JsonObject>,
}

/// One page of `tools/list`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ListToolsResult {
    pub tools: Vec<McpToolDefinition>,
    pub next_cursor: Option<String>,
}

fn parse_tool(value: &Value) -> Checked<McpToolDefinition> {
    let obj = object(value, "tools")?;
    let name = required_string(obj, "name")?;
    let title = optional_string(obj, "title")?;
    let description = optional_string(obj, "description")?;
    let input = object(
        obj.get("inputSchema").unwrap_or(&Value::Null),
        "inputSchema",
    )?;
    optional_object(input, "properties")?;
    optional_object(obj, "outputSchema")?;
    let annotations = match obj.get("annotations") {
        None => None,
        Some(Value::Object(a)) => {
            optional_string(a, "title")?;
            for flag in [
                "readOnlyHint",
                "destructiveHint",
                "idempotentHint",
                "openWorldHint",
            ] {
                optional_bool(a, flag)?;
            }
            Some(reorder(
                a,
                &[
                    "title",
                    "readOnlyHint",
                    "destructiveHint",
                    "idempotentHint",
                    "openWorldHint",
                ],
            ))
        }
        Some(_) => return Err(invalid("Invalid input: expected object at annotations")),
    };
    let meta = match obj.get("_meta") {
        None => None,
        Some(Value::Object(m)) => Some(m.clone()),
        Some(_) => return Err(invalid("Invalid input: expected record at _meta")),
    };
    Ok(McpToolDefinition {
        name,
        title,
        description,
        input_schema: reorder(input, &["type", "properties"]),
        annotations,
        meta,
    })
}

/// `ListToolsResultSchema`.
pub fn parse_list_tools_result(value: &Value) -> Checked<ListToolsResult> {
    let obj = object(value, "result")?;
    check_result_base(obj)?;
    let next_cursor = optional_string(obj, "nextCursor")?;
    let Some(Value::Array(items)) = obj.get("tools") else {
        return Err(invalid("Invalid input: expected array at tools"));
    };
    let tools = items.iter().map(parse_tool).collect::<Checked<Vec<_>>>()?;
    Ok(ListToolsResult { tools, next_cursor })
}

/// `z.base64()`.
static BASE64_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$")
        .unwrap()
});

fn is_base64(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| BASE64_RE.is_match(text))
}

fn is_optional_string(obj: &JsonObject, key: &str) -> bool {
    optional_string(obj, key).is_ok()
}

const RESOURCE_SHAPE: [&str; 4] = ["uri", "name", "title", "mimeType"];

fn parse_resource_contents(value: &Value) -> Option<Value> {
    let obj = value.as_object()?;
    let base_ok = obj.get("uri").is_some_and(Value::is_string)
        && RESOURCE_SHAPE[1..]
            .iter()
            .all(|key| is_optional_string(obj, key));
    if !base_ok {
        return None;
    }
    if obj.get("text").is_some_and(Value::is_string) {
        return Some(Value::Object(reorder(
            obj,
            &["uri", "name", "title", "mimeType", "text"],
        )));
    }
    if is_base64(obj.get("blob")) {
        return Some(Value::Object(reorder(
            obj,
            &["uri", "name", "title", "mimeType", "blob"],
        )));
    }
    None
}

/// One content part of a tool result: text, image, embedded resource, resource
/// link, or a part of another type.
fn parse_content_part(value: &Value) -> Option<Value> {
    let obj = value.as_object()?;
    let kind = obj.get("type").and_then(Value::as_str)?;
    match kind {
        "text" if obj.get("text").is_some_and(Value::is_string) => {
            Some(Value::Object(reorder(obj, &["type", "text"])))
        }
        "image"
            if is_base64(obj.get("data")) && obj.get("mimeType").is_some_and(Value::is_string) =>
        {
            Some(Value::Object(reorder(obj, &["type", "data", "mimeType"])))
        }
        "resource" => {
            let resource = parse_resource_contents(obj.get("resource")?)?;
            let mut out = reorder(obj, &["type", "resource"]);
            out.insert("resource".into(), resource);
            Some(Value::Object(out))
        }
        "resource_link"
            if obj.get("uri").is_some_and(Value::is_string)
                && obj.get("name").is_some_and(Value::is_string)
                && is_optional_string(obj, "description")
                && is_optional_string(obj, "mimeType") =>
        {
            Some(Value::Object(reorder(
                obj,
                &["type", "uri", "name", "description", "mimeType"],
            )))
        }
        "text" | "image" | "resource_link" => None,
        _ => Some(Value::Object(reorder(obj, &["type"]))),
    }
}

const CONTENT_RESULT_SHAPE: [&str; 5] = [
    "_meta",
    "resultType",
    "content",
    "structuredContent",
    "isError",
];

/// The result written in `CallToolResultWithContentSchema`'s order, with
/// `isError` defaulted to `false`.
fn content_result(obj: &JsonObject, content: Vec<Value>) -> Value {
    let mut out = JsonObject::new();
    for key in CONTENT_RESULT_SHAPE {
        match key {
            "content" => {
                out.insert("content".into(), Value::Array(content.clone()));
            }
            "isError" => {
                out.insert(
                    "isError".into(),
                    obj.get("isError").cloned().unwrap_or(Value::Bool(false)),
                );
            }
            _ => {
                if let Some(value) = obj.get(key) {
                    out.insert(key.into(), value.clone());
                }
            }
        }
    }
    for (key, value) in obj {
        if !CONTENT_RESULT_SHAPE.contains(&key.as_str()) {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

/// `CallToolResultSchema`: a result with `content`, one with only
/// `structuredContent` (given a text part holding its JSON), or a legacy one
/// with `toolResult`.
pub fn parse_call_tool_result(value: &Value) -> Checked<Value> {
    let obj = object(value, "result")?;
    check_result_base(obj)?;
    let is_error_ok = matches!(obj.get("isError"), None | Some(Value::Bool(_)));

    if let Some(Value::Array(items)) = obj.get("content")
        && is_error_ok
        && let Some(content) = items
            .iter()
            .map(parse_content_part)
            .collect::<Option<Vec<_>>>()
    {
        return Ok(content_result(obj, content));
    }
    if !obj.contains_key("content") && obj.contains_key("structuredContent") && is_error_ok {
        let text = js_stringify(&obj["structuredContent"]);
        let content = vec![json!({ "type": "text", "text": text })];
        return Ok(content_result(obj, content));
    }
    if obj.contains_key("toolResult") {
        return Ok(Value::Object(reorder(
            obj,
            &["_meta", "resultType", "toolResult"],
        )));
    }
    Err(invalid("Invalid input: expected a tool result"))
}
