//! Deferred tools: a tool whose schema the provider keeps out of the model's
//! context until a `load_tools` result names it. Each vendor names a tool
//! differently in that result, so each has a protocol here.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::llm_provider::{
    DeferredToolProtocol, ReplayedToolLoad, StoredToolLoad, ToolLoad, ToolLoadRequest, ToolLoader,
    provider_options,
};
use super::tool_changes::bare_model_id;
use crate::ai::{Tool, ToolResultOutput};

pub const LOAD_TOOLS_NAME: &str = "load_tools";

/// Every Claude and GPT model defers unless its id names a version known to refuse:
/// Claude before 4, which predates the Claude 4 naming, and GPT before 5.6, where
/// gpt-5.5 and gpt-5.4 fail to replay a load. A model whose API refuses anyway gets
/// its turn's request again with every tool in full (`invoke.rs`), and from then on
/// every tool in full.
static CLAUDE_BEFORE_4: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^claude-(?:\d|instant|v\d)").unwrap());
/// `gpt-5.5`, `gpt-4o`; `gpt-oss` names no version.
static GPT_VERSION: LazyLock<fancy_regex::Regex> =
    LazyLock::new(|| fancy_regex::Regex::new(r"^gpt-(\d+)(?:\.(\d+))?(?![\d.])").unwrap());
const GPT_FLOOR: (i64, i64) = (5, 6);

pub fn supports_anthropic_deferred_tools(model_id: &str) -> bool {
    let bare = bare_model_id(model_id);
    bare.starts_with("claude-") && !CLAUDE_BEFORE_4.is_match(&bare)
}

pub fn supports_open_ai_deferred_tools(model_id: &str) -> bool {
    let Ok(Some(captures)) = GPT_VERSION.captures(model_id) else {
        return true;
    };
    let major: i64 = captures
        .get(1)
        .and_then(|m| m.as_str().parse().ok())
        .unwrap_or(0);
    let minor: i64 = captures
        .get(2)
        .and_then(|m| m.as_str().parse().ok())
        .unwrap_or(0);
    major > GPT_FLOOR.0 || (major == GPT_FLOOR.0 && minor >= GPT_FLOOR.1)
}

static REFUSING_MODELS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// A provider's `deferred_tools`: the protocol on a model the rule admits, until
/// the API refuses a request that deferred tools on that model.
pub fn deferred_tools_when(
    admits: fn(&str) -> bool,
    protocol: &'static DeferredToolProtocol,
) -> Arc<dyn Fn(&str) -> Option<&'static DeferredToolProtocol> + Send + Sync> {
    Arc::new(move |model_id: &str| {
        if admits(model_id) && !REFUSING_MODELS.lock().contains(model_id) {
            Some(protocol)
        } else {
            None
        }
    })
}

/// Sends every tool in full to `model_id` until the process restarts. True when the
/// model was deferring until now.
pub fn record_deferral_refusal(model_id: &str) -> bool {
    REFUSING_MODELS.lock().insert(model_id.to_string())
}

/// The `load_tools` input schema as the AI SDK sends it for a `tool()` (draft-07).
pub static LOAD_REQUEST_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "names": {
                "description": "Exact tool names from the tool catalog.",
                "type": "array",
                "items": { "type": "string" }
            },
            "query": { "description": "Keywords naming what the tools do.", "type": "string" }
        },
        "additionalProperties": false
    })
});

/// The same schema as `z.toJSONSchema` writes it (draft 2020-12), which the OpenAI
/// client tool search sends as its `parameters`.
pub static LOAD_REQUEST_JSON_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "names": {
                "description": "Exact tool names from the tool catalog.",
                "type": "array",
                "items": { "type": "string" }
            },
            "query": { "description": "Keywords naming what the tools do.", "type": "string" }
        },
        "additionalProperties": false
    })
});

/// What the model reads when a load names no tool.
pub fn describe_load(load: &ToolLoad) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !load.loaded.is_empty() {
        parts.push(format!("Loaded: {}.", load.loaded.join(", ")));
    }
    if !load.unmatched.is_empty() {
        parts.push(format!("No tool matched: {}.", load.unmatched.join(", ")));
    }
    if !load.suggestions.is_empty() {
        parts.push(format!("Similar tools: {}.", load.suggestions.join(", ")));
    }
    if parts.is_empty() {
        "No tool matched. Name a tool from the catalog.".to_string()
    } else {
        parts.join(" ")
    }
}

fn tool_result_output(value: Value) -> ToolResultOutput {
    serde_json::from_value(value).expect("a tool result output")
}

/// A Messages API tool result holds either `tool_reference` blocks or text, never
/// both, so a load that found tools names only them.
fn anthropic_output(load: &ToolLoad) -> ToolResultOutput {
    if load.loaded.is_empty() {
        return tool_result_output(json!({ "type": "text", "value": describe_load(load) }));
    }
    let value: Vec<Value> = load
        .loaded
        .iter()
        .map(|tool_name| {
            json!({
                "type": "custom",
                "providerOptions": { "anthropic": { "type": "tool-reference", "toolName": tool_name } },
            })
        })
        .collect();
    tool_result_output(json!({ "type": "content", "value": value }))
}

/// The `load_tools` tool on the Anthropic Messages API: executes `loader.load` and
/// answers with `tool_reference` blocks.
fn anthropic_load_tool(loader: Arc<ToolLoader>) -> Tool {
    todo!()
}

fn anthropic_replay(call: &StoredToolLoad, _loader: &ToolLoader) -> ReplayedToolLoad {
    ReplayedToolLoad {
        id: call.id.clone(),
        input: call.input.clone(),
        output: anthropic_output(&call.result),
    }
}

pub static ANTHROPIC_DEFERRED_TOOLS: LazyLock<DeferredToolProtocol> =
    LazyLock::new(|| DeferredToolProtocol {
        deferred_tool: provider_options(json!({ "anthropic": { "deferLoading": true } })),
        keeps_tools_under_none: false,
        load_tool: anthropic_load_tool,
        replay: anthropic_replay,
    });

/// A client tool search call's input: the model's arguments and the call id.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct OpenAiSearchInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    arguments: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    call_id: Option<String>,
}

/// The arguments as the load request schema reads them; anything that does not
/// parse is an empty request.
fn open_ai_request(input: &OpenAiSearchInput) -> ToolLoadRequest {
    let Some(Value::Object(arguments)) = input.arguments.as_ref() else {
        return ToolLoadRequest::default();
    };
    let names = match arguments.get("names") {
        None => None,
        Some(Value::Array(items)) => {
            let mut names = Vec::with_capacity(items.len());
            for item in items {
                let Value::String(name) = item else {
                    return ToolLoadRequest::default();
                };
                names.push(name.clone());
            }
            Some(names)
        }
        Some(_) => return ToolLoadRequest::default(),
    };
    let query = match arguments.get("query") {
        None => None,
        Some(Value::String(query)) => Some(query.clone()),
        Some(_) => return ToolLoadRequest::default(),
    };
    ToolLoadRequest { names, query }
}

fn open_ai_output(load: &ToolLoad, loader: &ToolLoader) -> ToolResultOutput {
    let tools: Vec<Value> = load
        .loaded
        .iter()
        .filter_map(|name| (loader.definition)(name))
        .map(|definition| {
            json!({
                "type": "function",
                "name": definition.name,
                "description": definition.description,
                "parameters": Value::Object(definition.parameters),
                "strict": false,
                "defer_loading": true,
            })
        })
        .collect();
    tool_result_output(json!({ "type": "json", "value": { "tools": tools } }))
}

static NON_ALPHANUMERIC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9]").unwrap());

/// The Responses API takes a client `tool_search_call` id only when it starts with
/// `tsc`; under `store: true` any other id is read as a stored item.
fn open_ai_call_id(id: &str) -> String {
    format!("tsc_{}", NON_ALPHANUMERIC.replace_all(id, ""))
}

/// The OpenAI client tool search (`openai.tools.toolSearch` with
/// `execution: 'client'`): the runtime keeps the `ToolLoad` as the call's result
/// and the model output is the wire's `{ tools }`.
fn open_ai_load_tool(loader: Arc<ToolLoader>) -> Tool {
    todo!()
}

fn open_ai_replay(call: &StoredToolLoad, loader: &ToolLoader) -> ReplayedToolLoad {
    let id = open_ai_call_id(&call.id);
    let args = call
        .input
        .get("arguments")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    ReplayedToolLoad {
        input: json!({ "arguments": args, "call_id": id }),
        id,
        output: open_ai_output(&call.result, loader),
    }
}

pub static OPENAI_DEFERRED_TOOLS: LazyLock<DeferredToolProtocol> =
    LazyLock::new(|| DeferredToolProtocol {
        deferred_tool: provider_options(json!({ "openai": { "deferLoading": true } })),
        keeps_tools_under_none: true,
        load_tool: open_ai_load_tool,
        replay: open_ai_replay,
    });

/// A plain `load_tools` tool with no model output of its own: it executes
/// `loader.load` and returns the `ToolLoad`.
fn realtime_load_tool(loader: Arc<ToolLoader>) -> Tool {
    todo!()
}

fn realtime_replay(call: &StoredToolLoad, _loader: &ToolLoader) -> ReplayedToolLoad {
    ReplayedToolLoad {
        id: call.id.clone(),
        input: call.input.clone(),
        output: tool_result_output(json!({ "type": "text", "value": describe_load(&call.result) })),
    }
}

/// The Realtime API has no deferral, so a voice session declares the deferred tools
/// itself when a load names them (`services/voice/realtime_tools.rs`). A voice
/// session keeps no history, so nothing replays.
pub static REALTIME_DEFERRED_TOOLS: LazyLock<DeferredToolProtocol> =
    LazyLock::new(|| DeferredToolProtocol {
        deferred_tool: provider_options(json!({})),
        keeps_tools_under_none: true,
        load_tool: realtime_load_tool,
        replay: realtime_replay,
    });
