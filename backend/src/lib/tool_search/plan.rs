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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;

    use super::*;
    use crate::ai::{ToolExecutionOptions, execute_fn, json_schema};
    use crate::lib::llm_providers::deferred_tools::{
        ANTHROPIC_DEFERRED_TOOLS, OPENAI_DEFERRED_TOOLS,
    };
    use crate::lib::llm_providers::llm_provider::{provider_options, provider_options_json};

    /// A tool whose definition is about `chars` characters long.
    fn sized(chars: usize) -> Tool {
        Tool {
            description: Some("x".repeat(chars)),
            input_schema: json_schema(json!({ "type": "object" })),
            ..Default::default()
        }
    }

    fn tools(entries: Vec<(&str, Tool)>) -> ToolSet {
        entries
            .into_iter()
            .map(|(name, tool)| (name.to_string(), tool))
            .collect()
    }

    /// Two MCP tools of 47,000 characters together: 23,500 tokens, over 2% of the
    /// 1M window of `claude-opus-5-5`.
    fn input() -> PlanToolSearchInput {
        PlanToolSearchInput {
            tools: tools(vec![
                ("shell_exec", sized(100)),
                ("nexus__github__create_issue", sized(23_500)),
                ("nexus__gmail__send_email", sized(23_500)),
            ]),
            deferrable: vec![
                "nexus__github__create_issue".into(),
                "nexus__gmail__send_email".into(),
            ],
            protocol: Some(&ANTHROPIC_DEFERRED_TOOLS),
            model_id: "claude-opus-5-5".into(),
            telemetry: ToolSearchTelemetry {
                user_id: "u".into(),
                agent_id: "a".into(),
                mode: "chat".into(),
            },
        }
    }

    fn options_of(tool: &Tool) -> Option<Value> {
        tool.provider_options.as_ref().map(provider_options_json)
    }

    #[test]
    fn estimates_two_characters_per_token() {
        let definitions = [DeferredToolDefinition {
            name: "ab".into(),
            description: "cde".into(),
            parameters: json!({ "type": "object" }).as_object().unwrap().clone(),
        }];
        // 2 + 3 + 17 characters.
        assert_eq!(estimate_definition_tokens(&definitions), 11);
    }

    #[tokio::test]
    async fn defers_the_deferrable_tools_past_the_threshold_and_adds_load_tools_and_the_catalog() {
        let plan = plan_tool_search(input()).await;

        assert!(plan.active);
        assert_eq!(
            plan.deferred,
            ["nexus__github__create_issue", "nexus__gmail__send_email"]
        );
        assert_eq!(
            options_of(&plan.tools["nexus__github__create_issue"]),
            Some(json!({ "anthropic": { "deferLoading": true } }))
        );
        assert_eq!(options_of(&plan.tools["shell_exec"]), None);
        assert!(plan.tools.contains_key(LOAD_TOOLS_NAME));
        assert_eq!(plan.tools.keys().last().unwrap(), LOAD_TOOLS_NAME);
        assert!(
            plan.catalog
                .as_deref()
                .unwrap()
                .contains("- nexus__gmail__send_email")
        );
    }

    #[tokio::test]
    async fn sends_every_tool_as_it_is_under_the_threshold() {
        let mut request = input();
        request.tools = tools(vec![
            ("shell_exec", sized(100)),
            ("nexus__github__create_issue", sized(5_000)),
            ("nexus__gmail__send_email", sized(5_000)),
        ]);
        let names: Vec<String> = request.tools.keys().cloned().collect();
        let plan = plan_tool_search(request).await;
        assert!(!plan.active);
        assert!(plan.deferred.is_empty());
        assert!(!plan.summary_declares_tools);
        assert_eq!(plan.tools.keys().cloned().collect::<Vec<_>>(), names);
        let prompt = (plan.prompt_for)(ToolSet::new(), HashSet::new()).await;
        assert!(prompt.catalog.is_none() && prompt.replay_tool_call.is_none());
    }

    #[tokio::test]
    async fn keeps_the_execute_a_deferred_tool_arrives_with_so_the_risk_gate_still_runs_on_its_calls()
     {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&calls);
        let mut request = input();
        request
            .tools
            .get_mut("nexus__github__create_issue")
            .unwrap()
            .execute = Some(execute_fn(move |_: Value, _: ToolExecutionOptions| {
            let seen = Arc::clone(&seen);
            async move {
                seen.fetch_add(1, Ordering::SeqCst);
                Ok(json!("blocked by the risk gate"))
            }
        }));

        let plan = plan_tool_search(request).await;
        let result = (plan.tools["nexus__github__create_issue"]
            .execute
            .as_ref()
            .unwrap())(json!({}), ToolExecutionOptions::default())
        .await
        .unwrap();

        assert_eq!(result, json!("blocked by the risk gate"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn sends_every_tool_as_it_is_on_a_model_without_a_protocol() {
        let mut request = input();
        request.protocol = None;
        assert!(!plan_tool_search(request).await.active);
    }

    #[tokio::test]
    async fn defers_on_a_model_whose_window_is_unknown() {
        let mut request = input();
        request.model_id = "unknown-model".into();
        request.tools = tools(vec![("nexus__github__create_issue", sized(10))]);
        request.deferrable = vec!["nexus__github__create_issue".into()];
        assert!(plan_tool_search(request).await.active);
    }

    #[tokio::test]
    async fn loads_a_tool_by_a_query() {
        let plan = plan_tool_search(input()).await;
        let load = (plan.tools[LOAD_TOOLS_NAME].execute.as_ref().unwrap())(
            json!({ "query": "send an email" }),
            ToolExecutionOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(load["loaded"], json!(["nexus__gmail__send_email"]));
    }

    #[tokio::test]
    async fn a_summary_that_history_loads_tools_into_refuses_calls_under_auto_on_anthropic_only() {
        let mut anthropic = input();
        anthropic.model_id = "gpt-5.6-sol".into();
        assert!(plan_tool_search(anthropic).await.summary_declares_tools);
        let mut openai = input();
        openai.protocol = Some(&OPENAI_DEFERRED_TOOLS);
        openai.model_id = "gpt-5.6-sol".into();
        assert!(!plan_tool_search(openai).await.summary_declares_tools);
    }

    #[tokio::test]
    async fn prompt_for_builds_the_catalog_and_the_replay_from_the_declared_list_leaving_out_its_late_joiners()
     {
        let plan = plan_tool_search(input()).await;
        // The ledger keeps every tool the plan sent and appends a deferred tool that joined later.
        let mut declared = plan.tools.clone();
        let mut late = sized(10);
        late.provider_options = Some(provider_options(
            json!({ "anthropic": { "deferLoading": true } }),
        ));
        declared.insert("nexus__jira__create_ticket".into(), late);

        let prompt = (plan.prompt_for)(
            declared,
            HashSet::from(["nexus__jira__create_ticket".to_string()]),
        )
        .await;
        let output = json!({ "loaded": ["nexus__github__create_issue"], "unmatched": [], "suggestions": [] })
            .to_string();

        assert_eq!(prompt.catalog, plan.catalog);
        assert!(
            !prompt
                .catalog
                .as_deref()
                .unwrap()
                .contains(&format!("- {LOAD_TOOLS_NAME}"))
        );
        let replayed = (prompt.replay_tool_call.unwrap())(&ReplayedToolCall {
            id: "1".into(),
            tool: LOAD_TOOLS_NAME.into(),
            input: json!({}),
            output,
        })
        .unwrap();
        assert_eq!(
            serde_json::to_value(&replayed.output).unwrap(),
            json!({
                "type": "content",
                "value": [{ "type": "custom", "providerOptions": { "anthropic": { "type": "tool-reference", "toolName": "nexus__github__create_issue" } } }],
            })
        );
    }

    #[tokio::test]
    async fn replays_a_stored_load_keeping_only_tools_this_request_declares() {
        let plan = plan_tool_search(input()).await;
        let output = json!({
            "loaded": ["nexus__gmail__send_email", "nexus__gone__tool"],
            "unmatched": [],
            "suggestions": [],
        })
        .to_string();
        let replay = plan.replay_tool_call.unwrap();
        let replayed = replay(&ReplayedToolCall {
            id: "toolu_1".into(),
            tool: LOAD_TOOLS_NAME.into(),
            input: json!({}),
            output,
        })
        .unwrap();
        assert_eq!(replayed.id, "toolu_1");
        assert_eq!(replayed.input, json!({}));
        assert_eq!(
            serde_json::to_value(&replayed.output).unwrap(),
            json!({
                "type": "content",
                "value": [{ "type": "custom", "providerOptions": { "anthropic": { "type": "tool-reference", "toolName": "nexus__gmail__send_email" } } }],
            })
        );
    }

    #[tokio::test]
    async fn leaves_every_other_call_and_a_load_it_cannot_read_to_the_text_replay() {
        let plan = plan_tool_search(input()).await;
        let replay = plan.replay_tool_call.unwrap();
        let call = |tool: &str, output: &str| ReplayedToolCall {
            id: "1".into(),
            tool: tool.into(),
            input: json!({}),
            output: output.into(),
        };
        assert!(replay(&call("shell_exec", "{\"loaded\":[]}")).is_none());
        assert!(replay(&call(LOAD_TOOLS_NAME, "Error")).is_none());
    }

    #[test]
    fn reads_a_stored_load_keeping_only_strings() {
        assert_eq!(
            parse_stored_load("{\"loaded\":[\"a\",3],\"suggestions\":\"x\"}"),
            Some(ToolLoad {
                loaded: vec!["a".into()],
                unmatched: Vec::new(),
                suggestions: Vec::new(),
            })
        );
        assert_eq!(parse_stored_load("{\"loaded\":\"a\"}"), None);
        assert_eq!(parse_stored_load("null"), None);
    }
}
