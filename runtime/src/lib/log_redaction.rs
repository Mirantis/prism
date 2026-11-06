//! Errors, reduced to what an operator needs, and to nothing a log must not hold.
//!
//! A model-call error can carry the request it sent and the response it got. One
//! serializer on the logger, rather than an edit at each call site, keeps every
//! `err` field to an allow-list: the keys below are kept when their value is a
//! primitive, `cause` and `lastError` are reduced to a name and a message, `errors`
//! is reduced the same way and bounded at five, and every other key is dropped and
//! named in `redacted`. `message` is kept, so an error built by quoting model output
//! still quotes that much.

use serde_json::{Map, Value, json};

/// The keys an error may keep.
const ALLOWED_KEYS: [&str; 10] = [
    "name",
    "message",
    "stack",
    "code",
    "errno",
    "syscall",
    "statusCode",
    "url",
    "isRetryable",
    "reason",
];

/// Where an error hides another error, reduced one level deep.
const NESTED_KEYS: [&str; 2] = ["cause", "lastError"];

/// Where an error hides several errors.
const LIST_KEY: &str = "errors";
const LIST_LIMIT: usize = 5;

/// The one nested object read for a value: an AWS SDK error's HTTP status.
const METADATA_KEY: &str = "$metadata";

fn is_primitive(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_))
}

fn summarize(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let name = map.get("name").filter(|v| is_primitive(v)).cloned().unwrap_or_else(|| json!("Error"));
            let message = map
                .get("message")
                .filter(|v| is_primitive(v))
                .cloned()
                .unwrap_or_else(|| json!("(no message)"));
            json!({ "name": name, "message": message })
        }
        Value::String(s) => Value::String(s.clone()),
        other => Value::String(match other {
            Value::Null => "null".to_string(),
            v => v.to_string(),
        }),
    }
}

/// The `err` serializer for an error already described as JSON: an object with
/// `type` (or `name`), `message` and the fields above. A string or other primitive
/// becomes `{ type, message }`.
pub fn serialize_error_value(err: &Value) -> Value {
    let source = match err {
        Value::Object(map) => map,
        Value::String(s) => return json!({ "type": "string", "message": s }),
        Value::Null => return json!({ "type": "object", "message": "null" }),
        Value::Bool(b) => return json!({ "type": "boolean", "message": b.to_string() }),
        Value::Number(n) => return json!({ "type": "number", "message": n.to_string() }),
        Value::Array(_) => return json!({ "type": "object", "message": err.to_string() }),
    };

    let mut out = Map::new();
    out.insert(
        "type".into(),
        source.get("type").filter(|v| v.is_string()).cloned().unwrap_or_else(|| json!("Error")),
    );
    let mut kept: Vec<&str> = vec!["type"];

    for key in ALLOWED_KEYS {
        match source.get(key) {
            None | Some(Value::Null) => kept.push(key),
            Some(value) if is_primitive(value) => {
                out.insert(key.into(), value.clone());
                kept.push(key);
            }
            Some(_) => {}
        }
    }

    if !out.contains_key("statusCode") {
        if let Some(Value::Object(metadata)) = source.get(METADATA_KEY) {
            if let Some(status) = metadata.get("httpStatusCode").filter(|v| v.is_number()) {
                out.insert("statusCode".into(), status.clone());
            }
        }
    }

    for key in NESTED_KEYS {
        match source.get(key) {
            None | Some(Value::Null) => kept.push(key),
            Some(value) => {
                out.insert(key.into(), summarize(value));
                kept.push(key);
            }
        }
    }

    match source.get(LIST_KEY) {
        Some(Value::Array(list)) => {
            let mut summaries: Vec<Value> = list.iter().take(LIST_LIMIT).map(summarize).collect();
            if list.len() > LIST_LIMIT {
                summaries.push(Value::String(format!("(+{} more)", list.len() - LIST_LIMIT)));
            }
            out.insert(LIST_KEY.into(), Value::Array(summaries));
            kept.push(LIST_KEY);
        }
        None | Some(Value::Null) => kept.push(LIST_KEY),
        Some(_) => {}
    }

    let mut redacted: Vec<&String> = source.keys().filter(|key| !kept.contains(&key.as_str())).collect();
    redacted.sort();
    if !redacted.is_empty() {
        out.insert("redacted".into(), json!(redacted));
    }
    Value::Object(out)
}

/// An `anyhow::Error` as the `err` field of a log line: its message, the chain's
/// next error as `cause`, and the fields a typed error exposes through
/// [`ErrorFields`].
pub fn serialize_error(err: &anyhow::Error) -> Value {
    let mut map = Map::new();
    map.insert("type".into(), json!("Error"));
    map.insert("message".into(), json!(err.to_string()));
    for cause in err.chain() {
        if let Some(fields) = error_fields(cause) {
            for (key, value) in fields {
                map.entry(key).or_insert(value);
            }
        }
    }
    if let Some(next) = err.chain().nth(1) {
        map.insert("cause".into(), json!({ "name": "Error", "message": next.to_string() }));
    }
    serialize_error_value(&Value::Object(map))
}

/// Fields a typed error contributes to its log line (`name`, `statusCode`, `url`,
/// `isRetryable`, `code`, `reason`). Implemented by the runtime's own error types.
pub trait ErrorFields {
    fn error_fields(&self) -> Map<String, Value>;
}

type FieldsFn = fn(&(dyn std::error::Error + 'static)) -> Option<Map<String, Value>>;

/// Error types register here so `serialize_error` can read their fields from an
/// `anyhow` chain without this module naming them.
static FIELD_READERS: std::sync::RwLock<Vec<FieldsFn>> = std::sync::RwLock::new(Vec::new());

/// Registers a reader for one error type's log fields.
pub fn register_error_fields(reader: FieldsFn) {
    FIELD_READERS.write().expect("field readers").push(reader);
}

fn error_fields(err: &(dyn std::error::Error + 'static)) -> Option<Map<String, Value>> {
    if let Some(io) = err.downcast_ref::<std::io::Error>() {
        let mut map = Map::new();
        if let Some(code) = io.raw_os_error() {
            map.insert("errno".into(), json!(code));
        }
        return Some(map);
    }
    let readers = FIELD_READERS.read().ok()?;
    readers.iter().find_map(|read| read(err))
}

/// `json!({ "err": err_json(&e) })` is how a call site logs an error.
pub fn err_json(err: &anyhow::Error) -> Value {
    serialize_error(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_allow_list_and_names_the_rest() {
        let out = serialize_error_value(&json!({
            "type": "APICallError",
            "message": "Bad Request",
            "statusCode": 400,
            "requestBodyValues": { "messages": ["secret"] },
            "responseBody": "{}",
        }));
        assert_eq!(out["message"], "Bad Request");
        assert_eq!(out["statusCode"], 400);
        assert_eq!(out["redacted"], json!(["requestBodyValues", "responseBody"]));
        assert!(out.get("responseBody").is_none());
    }

    #[test]
    fn reduces_nested_and_listed_errors() {
        let errors: Vec<Value> = (0..7).map(|i| json!({ "name": "E", "message": format!("m{i}"), "body": "x" })).collect();
        let out = serialize_error_value(&json!({
            "message": "retry failed",
            "lastError": { "name": "APICallError", "message": "boom", "responseBody": "secret" },
            "errors": errors,
        }));
        assert_eq!(out["lastError"], json!({ "name": "APICallError", "message": "boom" }));
        assert_eq!(out["errors"].as_array().unwrap().len(), 6);
        assert_eq!(out["errors"][5], "(+2 more)");
    }

    #[test]
    fn lifts_the_aws_status() {
        let out = serialize_error_value(&json!({ "message": "denied", "$metadata": { "httpStatusCode": 403 } }));
        assert_eq!(out["statusCode"], 403);
        assert_eq!(out["redacted"], json!(["$metadata"]));
    }

    #[test]
    fn describes_a_thrown_primitive() {
        assert_eq!(serialize_error_value(&json!("oops")), json!({ "type": "string", "message": "oops" }));
    }
}
