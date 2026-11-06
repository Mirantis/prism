//! Whether one request sends its MCP tools deferred, and everything that follows
//! from it: the tools block, the `load_tools` tool, the catalog, and how a stored
//! load replays.

use std::collections::HashSet;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde_json::Value;

use crate::ai::{Tool, ToolSet};
use crate::lib::context_window::context_window_for;
use crate::lib::llm_providers::llm_provider::{
    DeferredToolDefinition, DeferredToolProtocol, ReplayedToolLoad, ToolLoad,
};
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
    todo!()
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
    todo!()
}
