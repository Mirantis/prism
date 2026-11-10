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
use crate::ai::providers::openai::tools::{ToolSearchArgs, tool_search};
use crate::ai::{
    ToModelOutputOptions, Tool, ToolExecuteFunction, ToolExecutionOptions, ToolResultOutput,
    ToolType, execute_fn, to_model_output_fn, tool, zod_schema,
};

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
    tool(Tool {
        description: Some(loader.description.clone()),
        input_schema: zod_schema(LOAD_REQUEST_SCHEMA.clone()),
        execute: Some(load_execute(loader)),
        to_model_output: Some(to_model_output_fn(
            |options: ToModelOutputOptions| async move {
                let load: ToolLoad = serde_json::from_value(options.output)?;
                Ok(anthropic_output(&load))
            },
        )),
        ..Default::default()
    })
}

/// `execute: async (request) => loader.load(request)`.
fn load_execute(loader: Arc<ToolLoader>) -> ToolExecuteFunction {
    execute_fn(move |input: Value, _options: ToolExecutionOptions| {
        let loader = Arc::clone(&loader);
        async move {
            let request: ToolLoadRequest = serde_json::from_value(input)?;
            Ok(serde_json::to_value((loader.load)(&request))?)
        }
    })
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
    let execute_loader = Arc::clone(&loader);
    let output_loader = Arc::clone(&loader);
    tool_search(ToolSearchArgs {
        execution: Some("client".into()),
        description: Some(loader.description.clone()),
        parameters: LOAD_REQUEST_JSON_SCHEMA.as_object().cloned(),
        execute: Some(execute_fn(
            move |input: Value, _options: ToolExecutionOptions| {
                let loader = Arc::clone(&execute_loader);
                async move {
                    let input: OpenAiSearchInput = serde_json::from_value(input)?;
                    Ok(serde_json::to_value((loader.load)(&open_ai_request(
                        &input,
                    )))?)
                }
            },
        )),
        to_model_output: Some(to_model_output_fn(move |options: ToModelOutputOptions| {
            let loader = Arc::clone(&output_loader);
            async move {
                let load: ToolLoad = serde_json::from_value(options.output)?;
                Ok(open_ai_output(&load, &loader))
            }
        })),
    })
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
    tool(Tool {
        description: Some(loader.description.clone()),
        input_schema: zod_schema(LOAD_REQUEST_SCHEMA.clone()),
        execute: Some(load_execute(loader)),
        ..Default::default()
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::ToModelOutputOptions;
    use crate::lib::llm_providers::llm_provider::DeferredToolDefinition;

    const ISSUE_TOOL: &str = "nexus__github__create_issue";

    fn parameters() -> Map<String, Value> {
        json!({ "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"] })
            .as_object()
            .unwrap()
            .clone()
    }

    fn loader() -> ToolLoader {
        ToolLoader {
            description: "Load tools.".into(),
            load: Arc::new(|request: &ToolLoadRequest| ToolLoad {
                loaded: vec![ISSUE_TOOL.into()],
                unmatched: request.names.clone().unwrap_or_default(),
                suggestions: request.query.clone().into_iter().collect(),
            }),
            definition: Arc::new(|name: &str| {
                (name == ISSUE_TOOL).then(|| DeferredToolDefinition {
                    name: name.into(),
                    description: "Create an issue.".into(),
                    parameters: parameters(),
                })
            }),
        }
    }

    fn load() -> ToolLoad {
        ToolLoad {
            loaded: vec![ISSUE_TOOL.into()],
            unmatched: Vec::new(),
            suggestions: Vec::new(),
        }
    }

    fn as_json(output: &ToolResultOutput) -> Value {
        serde_json::to_value(output).unwrap()
    }

    fn admits_refusing(model_id: &str) -> bool {
        model_id.starts_with("refusing-")
    }

    #[test]
    fn stops_deferring_on_a_model_once_its_api_refuses_deferred_tools() {
        let deferred_tools = deferred_tools_when(admits_refusing, &OPENAI_DEFERRED_TOOLS);
        assert!(deferred_tools("refusing-a").is_some());
        assert!(deferred_tools("other").is_none());
        assert!(record_deferral_refusal("refusing-a"));
        assert!(!record_deferral_refusal("refusing-a"));
        assert!(deferred_tools("refusing-a").is_none());
        assert!(deferred_tools("refusing-b").is_some());
    }

    #[test]
    fn admits_every_claude_from_4_and_every_gpt_from_5_6() {
        for model in [
            "claude-opus-5-5",
            "global.anthropic.claude-sonnet-4-5",
            "arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-opus-4-8",
        ] {
            assert!(supports_anthropic_deferred_tools(model), "{model}");
        }
        for model in [
            "claude-3-5-sonnet",
            "claude-instant-1",
            "claude-v2",
            "gpt-5.6-sol",
        ] {
            assert!(!supports_anthropic_deferred_tools(model), "{model}");
        }
        for model in ["gpt-5.6-sol", "gpt-5.10", "gpt-6", "gpt-oss-120b", "o3"] {
            assert!(supports_open_ai_deferred_tools(model), "{model}");
        }
        for model in ["gpt-5.5", "gpt-5.4-mini", "gpt-4o", "gpt-5"] {
            assert!(!supports_open_ai_deferred_tools(model), "{model}");
        }
    }

    #[test]
    fn describes_a_load_by_what_it_found_and_what_it_did_not() {
        assert_eq!(
            describe_load(&ToolLoad {
                loaded: vec!["a".into()],
                unmatched: vec!["jira".into()],
                suggestions: vec!["b".into(), "c".into()],
            }),
            "Loaded: a. No tool matched: jira. Similar tools: b, c."
        );
        assert_eq!(
            describe_load(&ToolLoad::default()),
            "No tool matched. Name a tool from the catalog."
        );
    }

    #[test]
    fn replays_an_anthropic_load_as_tool_reference_blocks() {
        let replayed = (ANTHROPIC_DEFERRED_TOOLS.replay)(
            &StoredToolLoad {
                id: "toolu_1".into(),
                input: json!({ "names": [ISSUE_TOOL] }),
                result: load(),
            },
            &loader(),
        );
        assert_eq!(replayed.id, "toolu_1");
        assert_eq!(replayed.input, json!({ "names": [ISSUE_TOOL] }));
        assert_eq!(
            as_json(&replayed.output),
            json!({
                "type": "content",
                "value": [{ "type": "custom", "providerOptions": { "anthropic": { "type": "tool-reference", "toolName": ISSUE_TOOL } } }],
            })
        );
    }

    #[test]
    fn replays_an_anthropic_load_that_found_nothing_as_text() {
        let empty = ToolLoad {
            loaded: Vec::new(),
            unmatched: vec!["jira".into()],
            suggestions: vec![ISSUE_TOOL.into()],
        };
        let replayed = (ANTHROPIC_DEFERRED_TOOLS.replay)(
            &StoredToolLoad {
                id: "toolu_1".into(),
                input: json!({}),
                result: empty.clone(),
            },
            &loader(),
        );
        assert_eq!(
            as_json(&replayed.output),
            json!({ "type": "text", "value": describe_load(&empty) })
        );
    }

    #[test]
    fn replays_an_openai_load_as_a_client_tool_search_with_a_tsc_id_and_the_definitions() {
        let replayed = (OPENAI_DEFERRED_TOOLS.replay)(
            &StoredToolLoad {
                id: "call_abc-1".into(),
                input: json!({ "arguments": { "names": [ISSUE_TOOL] }, "call_id": "call_abc-1" }),
                result: load(),
            },
            &loader(),
        );
        assert_eq!(replayed.id, "tsc_callabc1");
        assert_eq!(
            replayed.input,
            json!({ "arguments": { "names": [ISSUE_TOOL] }, "call_id": "tsc_callabc1" })
        );
        assert_eq!(
            as_json(&replayed.output),
            json!({
                "type": "json",
                "value": { "tools": [{
                    "type": "function",
                    "name": ISSUE_TOOL,
                    "description": "Create an issue.",
                    "parameters": parameters(),
                    "strict": false,
                    "defer_loading": true,
                }] },
            })
        );
    }

    #[test]
    fn replays_an_openai_load_without_arguments_with_empty_ones() {
        let replayed = (OPENAI_DEFERRED_TOOLS.replay)(
            &StoredToolLoad {
                id: "x".into(),
                input: json!({ "arguments": null }),
                result: ToolLoad::default(),
            },
            &loader(),
        );
        assert_eq!(
            replayed.input,
            json!({ "arguments": {}, "call_id": "tsc_x" })
        );
    }

    #[tokio::test]
    async fn the_anthropic_load_tool_runs_the_loader_and_answers_with_tool_references() {
        let tool = (ANTHROPIC_DEFERRED_TOOLS.load_tool)(Arc::new(loader()));
        assert_eq!(tool.description.as_deref(), Some("Load tools."));
        assert_eq!(tool.input_schema.json_schema(), &*LOAD_REQUEST_SCHEMA);
        let output = (tool.execute.as_ref().unwrap())(
            json!({ "names": ["x"], "query": "q" }),
            ToolExecutionOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(
            output,
            json!({ "loaded": [ISSUE_TOOL], "unmatched": ["x"], "suggestions": ["q"] })
        );
        let model_output = (tool.to_model_output.as_ref().unwrap())(ToModelOutputOptions {
            tool_call_id: "t".into(),
            input: json!({}),
            output,
        })
        .await
        .unwrap();
        assert_eq!(model_output.type_name(), "content");
    }

    #[tokio::test]
    async fn the_openai_load_tool_is_a_client_tool_search_that_reads_its_arguments() {
        let tool = (OPENAI_DEFERRED_TOOLS.load_tool)(Arc::new(loader()));
        let ToolType::Provider { id, args, .. } = &tool.tool_type else {
            panic!("a provider tool");
        };
        assert_eq!(id, "openai.tool_search");
        assert_eq!(
            Value::Object(args.clone()),
            json!({ "execution": "client", "description": "Load tools.", "parameters": *LOAD_REQUEST_JSON_SCHEMA })
        );
        let execute = tool.execute.as_ref().unwrap();
        let good = execute(
            json!({ "arguments": { "names": ["x"], "extra": 2 }, "call_id": "c" }),
            ToolExecutionOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(good["unmatched"], json!(["x"]));
        let bad = execute(
            json!({ "arguments": { "names": "x" } }),
            ToolExecutionOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(bad["unmatched"], json!([]));
        assert_eq!(bad["suggestions"], json!([]));
    }
}
