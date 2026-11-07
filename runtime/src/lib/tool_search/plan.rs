//! Whether one request sends its MCP tools deferred, and everything that follows
//! from it: the tools block, the `load_tools` tool, the catalog, and how a stored
//! load replays.

use std::collections::HashSet;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::Value;

use indexmap::IndexMap;

use crate::ai::{Tool, ToolSet};
use crate::config::{CONFIG, ToolSearchMode};
use crate::lib::context_window::context_window_for;
use crate::lib::llm_providers::deferred_tools::LOAD_TOOLS_NAME;
use crate::lib::llm_providers::llm_provider::{
    DeferredToolDefinition, DeferredToolProtocol, ReplayedToolLoad, StoredToolLoad, ToolLoad,
    ToolLoadRequest, ToolLoader, is_deferred_tool, merge_provider_options,
};
use crate::lib::telemetry::track_event;
use crate::lib::tool_search::catalog::build_tool_catalog;
use crate::lib::tool_search::tool_index::ToolIndex;
use crate::support::js::len16;

/// Real MCP schemas measured 2.2 to 2.4 characters per input token on Claude, as
/// JSON is dense in tokens. Rounding down errs towards deferring.
const CHARS_PER_TOKEN: usize = 2;

/// A stored tool call as history replays it.
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayedToolCall {
    pub id: String,
    pub tool: String,
    pub input: Value,
    pub output: String,
}

/// A stored `load_tools` call as a request sends it, or `None` for any other call.
pub type ReplayToolCall = Arc<dyn Fn(&ReplayedToolCall) -> Option<ReplayedToolLoad> + Send + Sync>;

/// What a request with deferred tools adds to its prompt.
#[derive(Clone, Default)]
pub struct ToolSearchPrompt {
    /// The `# Tool Catalog` section, when active.
    pub catalog: Option<String>,
    /// A stored `load_tools` call as this request sends it, or `None` for any
    /// other call.
    pub replay_tool_call: Option<ReplayToolCall>,
}

/// The prompt for a conversation's declared list (`tool_ledger_service.rs`), which
/// keeps a tool this turn does not offer. The set holds the tools an announcement
/// loads, which the catalog leaves out.
pub type PromptFor =
    Arc<dyn Fn(ToolSet, HashSet<String>) -> BoxFuture<'static, ToolSearchPrompt> + Send + Sync>;

#[derive(Clone)]
pub struct ToolSearchPlan {
    pub tools: ToolSet,
    pub active: bool,
    /// The tools sent deferred.
    pub deferred: Vec<String>,
    /// A summary request declares the tools under tool choice 'auto' and refuses
    /// every call, since the SDK sends no tools block under 'none'.
    pub summary_declares_tools: bool,
    /// The `# Tool Catalog` section, when active.
    pub catalog: Option<String>,
    /// A stored `load_tools` call as this request sends it, or `None` for any other
    /// call.
    pub replay_tool_call: Option<ReplayToolCall>,
    /// The prompt for a conversation's declared list (`tool_ledger_service.rs`),
    /// which keeps a tool this turn does not offer. `joined_later` are the tools an
    /// announcement loads, which the catalog leaves out.
    pub prompt_for: PromptFor,
}

/// Who the `tools loaded` event is for.
#[derive(Debug, Clone, Default)]
pub struct ToolSearchTelemetry {
    pub user_id: String,
    pub agent_id: String,
    pub mode: String,
}

pub struct PlanToolSearchInput {
    pub tools: ToolSet,
    /// Names in `tools` that may be sent deferred.
    pub deferrable: Vec<String>,
    pub protocol: Option<&'static DeferredToolProtocol>,
    pub model_id: String,
    pub telemetry: ToolSearchTelemetry,
}

/// A tool's definition as a deferred load names it: its name, its description when
/// it is a string (else empty), and its input schema as JSON schema.
async fn definition_of(name: &str, tool: &Tool) -> DeferredToolDefinition {
    DeferredToolDefinition {
        name: name.to_string(),
        description: tool.description.clone().unwrap_or_default(),
        parameters: tool
            .input_schema
            .json_schema()
            .as_object()
            .cloned()
            .unwrap_or_default(),
    }
}

/// A char/2 estimate of what the definitions add to every request.
pub fn estimate_definition_tokens(definitions: &[DeferredToolDefinition]) -> i64 {
    let chars: usize = definitions
        .iter()
        .map(|d| {
            let parameters = serde_json::to_string(&d.parameters).unwrap_or_default();
            len16(&d.name) + len16(&d.description) + len16(&parameters)
        })
        .sum();
    chars.div_ceil(CHARS_PER_TOKEN) as i64
}

/// Defer when the definitions take more than the threshold's share of the window.
/// Every model with a protocol has a known window; one without defers.
pub fn exceeds_threshold(tokens: i64, model_id: &str, percent: f64) -> bool {
    let Some(window) = context_window_for(model_id)
        .map(|w| w.tokens)
        .filter(|w| *w != 0)
    else {
        return true;
    };
    tokens as f64 > (window as f64 * percent) / 100.0
}

/// The stored result of a `load_tools` call, or `None` when it holds none.
pub fn parse_stored_load(output: &str) -> Option<ToolLoad> {
    let value: Value = serde_json::from_str(output).ok()?;
    let Value::Object(map) = value else {
        return None;
    };
    if !map.get("loaded").is_some_and(Value::is_array) {
        return None;
    }
    let strings = |list: Option<&Value>| -> Vec<String> {
        match list {
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect(),
            _ => Vec::new(),
        }
    };
    Some(ToolLoad {
        loaded: strings(map.get("loaded")),
        unmatched: strings(map.get("unmatched")),
        suggestions: strings(map.get("suggestions")),
    })
}

pub const LOAD_TOOLS_DESCRIPTION: &str = "Load tools listed in the Tool Catalog so you can call them. Pass `names` from the catalog, or a `query` that says what the tools do; a query loads the best few matches. A loaded tool stays loaded in later turns.";

/// Plan one request's tool search.
///
/// Inactive (the tools unchanged, nothing deferred, `summary_declares_tools: false`,
/// a `prompt_for` that answers an empty prompt) when there is no protocol,
/// `CONFIG.tool_search` is `off`, no deferrable name is in the tools, or the
/// deferrable definitions do not exceed `CONFIG.tool_search_threshold_percent` of
/// the model's window.
///
/// Active: a `ToolIndex` over the deferrable definitions backs a `ToolLoader` with
/// `LOAD_TOOLS_DESCRIPTION`, whose `load` emits `tools loaded` (`agent.id`,
/// `invoke.mode`, `tool.count`, `deferred.count`, `match` — `names`, `query` or
/// `both`). The deferrable tools get the protocol's `deferred_tool` options merged
/// into theirs, `load_tools` is added last, and the plan has the catalog of the
/// deferrable definitions. Replaying a stored `load_tools` call keeps only the
/// loaded names the request declares, since a result naming an undeclared tool
/// fails it. `prompt_for` builds the catalog from the sent tools that are deferred,
/// other than `load_tools` and the ones that joined later.
pub async fn plan_tool_search(input: PlanToolSearchInput) -> ToolSearchPlan {
    let PlanToolSearchInput {
        tools: input_tools,
        deferrable: input_deferrable,
        protocol,
        model_id,
        telemetry,
    } = input;
    let inactive = |tools: ToolSet| ToolSearchPlan {
        tools,
        active: false,
        deferred: Vec::new(),
        summary_declares_tools: false,
        catalog: None,
        replay_tool_call: None,
        prompt_for: Arc::new(|_, _| Box::pin(async { ToolSearchPrompt::default() })),
    };
    let Some(protocol) = protocol else {
        return inactive(input_tools);
    };
    if CONFIG.tool_search == ToolSearchMode::Off {
        return inactive(input_tools);
    }

    let deferrable: Vec<String> = input_deferrable
        .into_iter()
        .filter(|name| input_tools.contains_key(name))
        .collect();
    if deferrable.is_empty() {
        return inactive(input_tools);
    }

    let mut definitions = Vec::with_capacity(deferrable.len());
    for name in &deferrable {
        definitions.push(definition_of(name, &input_tools[name]).await);
    }
    let tokens = estimate_definition_tokens(&definitions);
    if !exceeds_threshold(tokens, &model_id, CONFIG.tool_search_threshold_percent) {
        return inactive(input_tools);
    }

    let index = Arc::new(ToolIndex::new(&definitions));
    let definition_index = Arc::clone(&index);
    let load_index = Arc::clone(&index);
    let loader = Arc::new(ToolLoader {
        description: LOAD_TOOLS_DESCRIPTION.to_string(),
        definition: Arc::new(move |name: &str| definition_index.definition(name)),
        load: Arc::new(move |request: &ToolLoadRequest| {
            let load = load_index.load(request);
            let by_names = request
                .names
                .as_ref()
                .is_some_and(|names| !names.is_empty());
            let by_query = request
                .query
                .as_ref()
                .is_some_and(|query| !query.is_empty());
            let matched = match (by_names, by_query) {
                (true, true) => "both",
                (true, false) => "names",
                (false, _) => "query",
            };
            let mut props = IndexMap::new();
            props.insert("agent.id".to_string(), telemetry.agent_id.clone());
            props.insert("invoke.mode".to_string(), telemetry.mode.clone());
            props.insert("tool.count".to_string(), load.loaded.len().to_string());
            props.insert("deferred.count".to_string(), load_index.size().to_string());
            props.insert("match".to_string(), matched.to_string());
            track_event("tools loaded", Some(&telemetry.user_id), Some(props));
            load
        }),
    });

    let deferred_set: HashSet<&str> = deferrable.iter().map(String::as_str).collect();
    let mut tools = ToolSet::new();
    for (name, tool) in &input_tools {
        let tool = if deferred_set.contains(name.as_str()) {
            Tool {
                provider_options: Some(merge_provider_options([
                    tool.provider_options.as_ref(),
                    Some(&protocol.deferred_tool),
                ])),
                ..tool.clone()
            }
        } else {
            tool.clone()
        };
        tools.insert(name.clone(), tool);
    }
    tools.insert(
        LOAD_TOOLS_NAME.to_string(),
        (protocol.load_tool)(Arc::clone(&loader)),
    );

    let replay_tool_call = replay_for(&tools, protocol, Arc::clone(&loader));
    let prompt_loader = Arc::clone(&loader);
    ToolSearchPlan {
        active: true,
        deferred: deferrable,
        summary_declares_tools: !protocol.keeps_tools_under_none,
        catalog: Some(build_tool_catalog(&definitions, None)),
        replay_tool_call: Some(replay_tool_call),
        prompt_for: Arc::new(move |sent: ToolSet, joined_later: HashSet<String>| {
            let loader = Arc::clone(&prompt_loader);
            Box::pin(async move {
                let mut listed = Vec::new();
                for (name, tool) in &sent {
                    if name != LOAD_TOOLS_NAME
                        && !joined_later.contains(name)
                        && is_deferred_tool(tool)
                    {
                        listed.push(definition_of(name, tool).await);
                    }
                }
                ToolSearchPrompt {
                    catalog: Some(build_tool_catalog(&listed, None)),
                    replay_tool_call: Some(replay_for(&sent, protocol, loader)),
                }
            })
        }),
        tools,
    }
}

/// A stored `load_tools` call as a request that declares `sent` sends it. A load
/// result naming a tool the request does not declare fails it.
fn replay_for(
    sent: &ToolSet,
    protocol: &'static DeferredToolProtocol,
    loader: Arc<ToolLoader>,
) -> ReplayToolCall {
    let sent: HashSet<String> = sent.keys().cloned().collect();
    Arc::new(move |call: &ReplayedToolCall| {
        if call.tool != LOAD_TOOLS_NAME {
            return None;
        }
        let stored = parse_stored_load(&call.output)?;
        let result = ToolLoad {
            loaded: stored
                .loaded
                .into_iter()
                .filter(|name| sent.contains(name))
                .collect(),
            ..stored
        };
        Some((protocol.replay)(
            &StoredToolLoad {
                id: call.id.clone(),
                input: call.input.clone(),
                result,
            },
            &loader,
        ))
    })
}
