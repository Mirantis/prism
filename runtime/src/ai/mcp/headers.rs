//! HTTP headers of the MCP transports: the request headers every request
//! carries, and the `Mcp-Param-*` headers a tool's `x-mcp-header` properties
//! produce.

use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde_json::Value;

use super::types::JsonObject;
use crate::ai::json::bytes_to_base64;

/// The `@ai-sdk/mcp` version, which ends the `user-agent` of every request.
pub const MCP_PACKAGE_VERSION: &str = "2.0.73";

static HTTP_TOKEN_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$").unwrap());
static BASE64_SENTINEL_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^=\?base64\?.*\?=$").unwrap());

/// The headers as `fetch` sends them: the object's keys in order (a later key of
/// the same spelling replaces an earlier one), names lowercased, values of names
/// that differ only in case joined with `, `, and `ai-sdk/<version>` appended to
/// `user-agent`.
pub fn request_headers(pairs: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut spelled: IndexMap<String, String> = IndexMap::new();
    for (name, value) in pairs {
        spelled.insert(name, value);
    }
    let mut merged: BTreeMap<String, String> = BTreeMap::new();
    for (name, value) in spelled {
        let lower = name.to_lowercase();
        match merged.get_mut(&lower) {
            Some(existing) => {
                existing.push_str(", ");
                existing.push_str(&value);
            }
            None => {
                merged.insert(lower, value);
            }
        }
    }
    let current = merged.get("user-agent").cloned().unwrap_or_default();
    let agent = [current.as_str(), &format!("ai-sdk/{MCP_PACKAGE_VERSION}")]
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    merged.insert("user-agent".into(), agent);
    merged.into_iter().collect()
}

/// `encodeMCPHeaderValue`: printable ASCII without surrounding whitespace as it
/// is, anything else as `=?base64?<UTF-8 as base64>?=`.
pub fn encode_mcp_header_value(value: &str) -> String {
    let plain_ascii = value.chars().all(|c| {
        let unit = c.encode_utf16(&mut [0u16; 2])[0];
        unit == 0x09 || (0x20..=0x7e).contains(&unit)
    });
    if plain_ascii
        && crate::support::js::trim(value) == value
        && !BASE64_SENTINEL_PATTERN.is_match(value)
    {
        return value.to_string();
    }
    format!("=?base64?{}?=", bytes_to_base64(value.as_bytes()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderValueType {
    Boolean,
    Integer,
    String,
}

/// A tool argument that is mirrored into an `Mcp-Param-<name>` header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MCPToolHeaderBinding {
    pub header_name: String,
    pub path: Vec<String>,
    pub value_type: HeaderValueType,
}

/// `getMCPToolHeaderBindings`: the `x-mcp-header` properties of an input schema,
/// or why the schema's use of them is invalid.
pub fn get_mcp_tool_header_bindings(
    input_schema: &JsonObject,
) -> Result<Vec<MCPToolHeaderBinding>, String> {
    struct Visit {
        bindings: Vec<MCPToolHeaderBinding>,
        header_names: HashSet<String>,
        error: Option<String>,
    }

    fn visit(state: &mut Visit, value: &Value, path: &[String], statically_reachable: bool) {
        if state.error.is_some() {
            return;
        }
        let Some(record) = value.as_object() else {
            return;
        };

        if let Some(header) = record.get("x-mcp-header") {
            if !statically_reachable || path.is_empty() {
                state.error = Some("x-mcp-header is not on a statically reachable property".into());
                return;
            }
            let Some(header_name) = header.as_str().filter(|h| HTTP_TOKEN_PATTERN.is_match(h))
            else {
                state.error = Some("x-mcp-header must be a non-empty HTTP token".into());
                return;
            };
            let normalized = header_name.to_lowercase();
            if state.header_names.contains(&normalized) {
                state.error = Some(format!(
                    "x-mcp-header value \"{header_name}\" is not unique"
                ));
                return;
            }
            let value_type = match record.get("type").and_then(Value::as_str) {
                Some("boolean") => HeaderValueType::Boolean,
                Some("integer") => HeaderValueType::Integer,
                Some("string") => HeaderValueType::String,
                _ => {
                    state.error = Some(
                        "x-mcp-header can only annotate boolean, integer, or string properties"
                            .into(),
                    );
                    return;
                }
            };
            state.header_names.insert(normalized);
            state.bindings.push(MCPToolHeaderBinding {
                header_name: header_name.to_string(),
                path: path.to_vec(),
                value_type,
            });
        }

        for (key, child) in record {
            if key == "x-mcp-header" {
                continue;
            }
            match child {
                Value::Object(properties) if key == "properties" => {
                    for (property_name, property_schema) in properties {
                        let mut next = path.to_vec();
                        next.push(property_name.clone());
                        visit(state, property_schema, &next, statically_reachable);
                    }
                }
                _ => visit(state, child, path, false),
            }
        }
    }

    let mut state = Visit {
        bindings: Vec::new(),
        header_names: HashSet::new(),
        error: None,
    };
    visit(&mut state, &Value::Object(input_schema.clone()), &[], true);
    match state.error {
        None => Ok(state.bindings),
        Some(error) => Err(error),
    }
}

/// `createMCPToolHeaders`: one `Mcp-Param-<name>` header per bound argument the
/// call has. Fails when an argument does not have its header's type.
pub fn create_mcp_tool_headers(
    bindings: &[MCPToolHeaderBinding],
    args: &JsonObject,
) -> anyhow::Result<Vec<(String, String)>> {
    let mut headers = Vec::new();
    for binding in bindings {
        let Some(value) = value_at_path(args, &binding.path).filter(|v| !v.is_null()) else {
            continue;
        };
        let matches = match binding.value_type {
            HeaderValueType::String => value.is_string(),
            HeaderValueType::Boolean => value.is_boolean(),
            HeaderValueType::Integer => is_safe_integer(&value),
        };
        if !matches {
            anyhow::bail!(
                "Tool argument \"{}\" does not match its x-mcp-header type",
                binding.path.join(".")
            );
        }
        let text = match &value {
            Value::String(s) => s.clone(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => crate::ai::json::js_number_text(n.as_f64().unwrap_or(0.0)),
            other => other.to_string(),
        };
        headers.push((
            format!("Mcp-Param-{}", binding.header_name),
            encode_mcp_header_value(&text),
        ));
    }
    Ok(headers)
}

/// `getValueAtPath`: the value under `path`, or `None` where a step is not an object.
fn value_at_path(args: &JsonObject, path: &[String]) -> Option<Value> {
    let mut current = Value::Object(args.clone());
    for segment in path {
        let next = current.as_object()?.get(segment)?.clone();
        current = next;
    }
    Some(current)
}

fn is_safe_integer(value: &Value) -> bool {
    match value.as_f64() {
        Some(f) => f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0,
        None => false,
    }
}
