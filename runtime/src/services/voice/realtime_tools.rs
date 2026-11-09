//! Offer a set of the agent's tools to a Realtime session, and run them when it calls.
//!
//! Every voice session needs this, and one session can own more than one set: the agent's
//! own tools, and the tools of the computer it is working on. So this file holds the
//! adapter and nothing about whose tools it adapts. The caller names itself with `label`,
//! which is what the log lines and the tool-call ids say, and supplies the sentence a
//! truncated result carries, since what the model can do with the part it cannot see
//! depends on the call it is in.
//!
//! Running the tools in this process is not a choice: they are in-process closures over
//! service singletons and a single-writer SQLite handle, and a remote executor could not
//! dial into the container anyway.

use std::collections::HashSet;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::ai::{Tool, ToolExecutionOptions, ToolSet};
use crate::lib::llm_providers::deferred_tools::{LOAD_TOOLS_NAME, describe_load};
use crate::lib::llm_providers::llm_provider::ToolLoad;
use crate::lib::tool_output_limiter::{ToolOutputCaptureOptions, render_and_spill};
use crate::services::meeting::realtime_session::RealtimeFunctionTool;
use crate::{log_debug, log_info, log_warn};

/// Cap on a tool result handed back to the Realtime model.
///
/// Smaller than the chat-path budget (`lib/tool_output_limiter.rs`) on purpose, and
/// for a reason particular to this transport: a tool result stays in the Realtime
/// session's context for the rest of the call, and that context is far smaller than
/// the chat model's window. This model also *speaks* its answer, so a 100 kB
/// `kubectl get` dump only produces a monologue nobody wants.
///
/// It used to be 4,000, which cut a single Jira issue's description in half and beheaded
/// a PR listing — so the agent stated the count it could see as the total. 12,000
/// (~3k tokens) holds a long issue or a few dozen listed items while staying a modest
/// share of the session. The *shape* of the cut is chat's, not this file's: shared
/// head+tail, and a notice that says outright the result is incomplete.
pub const MAX_TOOL_RESULT_CHARS: usize = 12_000;

/// The tools declared now. A `load_tools` call can change the answer, and a caller tells
/// a changed set from the same one by `Arc::ptr_eq`.
pub type DeclarationsFn = Arc<dyn Fn() -> Arc<Vec<RealtimeFunctionTool>> + Send + Sync>;

/// Run one call by name with the model's raw JSON arguments, answering the text the
/// model reads. Never fails: a failure is an error the model can speak.
pub type ExecuteFn = Arc<dyn Fn(String, String) -> BoxFuture<'static, String> + Send + Sync>;

/// A tool set a Realtime session can be given, and the way to run what it calls.
#[derive(Clone)]
pub struct PreparedTools {
    /// The tools declared now; a `load_tools` call adds the ones it loads.
    pub declarations: DeclarationsFn,
    pub count: usize,
    pub execute: ExecuteFn,
    /// The `# Tool Catalog` section the instructions end with, when tools are deferred.
    pub catalog: Option<String>,
}

impl PreparedTools {
    /// The tools declared now.
    pub fn declarations(&self) -> Arc<Vec<RealtimeFunctionTool>> {
        (self.declarations)()
    }

    /// Run one call and answer the text for the model.
    pub async fn execute(&self, name: &str, arguments_json: &str) -> String {
        (self.execute)(name.to_string(), arguments_json.to_string()).await
    }
}

#[derive(Debug, Clone, Default)]
pub struct RealtimeToolsOptions {
    /// Names the owner in the log lines and in the tool-call ids.
    pub label: String,
    /// What a truncated result tells the model to do with the part it cannot see.
    pub truncation_guidance: String,
    /// Tools declared only once a `load_tools` call names them.
    pub deferred: Option<HashSet<String>>,
    pub catalog: Option<String>,
}

/// How a `load_tools` result is rendered for the model.
type RenderLoad = Arc<dyn Fn(ToolLoad) -> String + Send + Sync>;

/// Adapt a set of the agent's tools for the Realtime API.
///
/// A tool with no local implementation is left out rather than declared: offering one
/// produces a call this file cannot answer.
pub fn prepare_realtime_tools(tools: &ToolSet, options: RealtimeToolsOptions) -> PreparedTools {
    let mut usable = ToolSet::new();
    for (name, tool) in tools {
        if tool.execute.is_none() {
            log_debug!("[{}] Skipping non-executable tool {}", options.label, name);
            continue;
        }
        usable.insert(name.clone(), tool.clone());
    }

    let all: Arc<Vec<RealtimeFunctionTool>> = Arc::new(
        usable
            .iter()
            .map(|(name, tool)| RealtimeFunctionTool {
                name: name.clone(),
                description: describe_tool(tool).unwrap_or_else(|| name.clone()),
                // The schema the model is given, for zod-built and plain JSON Schema tools
                // alike.
                parameters: tool.input_schema.json_schema().clone(),
            })
            .collect(),
    );
    let deferred: HashSet<String> = options.deferred.clone().unwrap_or_default();
    let declared = declare(&all, &deferred);
    // The deferred names and the declarations they leave, changed together by a load.
    let state = Arc::new(Mutex::new((deferred, declared)));

    let load: RenderLoad = {
        let state = state.clone();
        let all = all.clone();
        Arc::new(move |result: ToolLoad| {
            let mut state = state.lock();
            let mut added = 0;
            for name in &result.loaded {
                if state.0.remove(name) {
                    added += 1;
                }
            }
            if added > 0 {
                state.1 = declare(&all, &state.0);
            }
            describe_load(&result)
        })
    };

    let declarations: DeclarationsFn = {
        let state = state.clone();
        Arc::new(move || state.lock().1.clone())
    };

    let usable = Arc::new(usable);
    let options = Arc::new(options);
    let execute: ExecuteFn = {
        let state = state.clone();
        let options = options.clone();
        Arc::new(move |name: String, arguments_json: String| {
            if state.lock().0.contains(&name) {
                let error =
                    json!({ "error": format!("Load {name} with {LOAD_TOOLS_NAME} first.") })
                        .to_string();
                return async move { error }.boxed();
            }
            let render = (name == LOAD_TOOLS_NAME).then(|| load.clone());
            execute_tool(
                usable.clone(),
                name,
                arguments_json,
                options.clone(),
                render,
            )
            .boxed()
        })
    };

    PreparedTools {
        declarations,
        count: all.len(),
        execute,
        catalog: options
            .catalog
            .clone()
            .filter(|catalog| !catalog.is_empty()),
    }
}

/// The declarations of every tool not waiting to be loaded.
fn declare(
    all: &[RealtimeFunctionTool],
    deferred: &HashSet<String>,
) -> Arc<Vec<RealtimeFunctionTool>> {
    Arc::new(
        all.iter()
            .filter(|declaration| !deferred.contains(&declaration.name))
            .cloned()
            .collect(),
    )
}

/// A tool's description as plain text, or `None` when it declares none.
///
/// A description may be a function of the tool's execution context, so a declaration has
/// to resolve it rather than read it. Nothing here gives a tool a context (see
/// `execute_tool`), so it resolves with none.
fn describe_tool(tool: &Tool) -> Option<String> {
    tool.description.clone()
}

/// Run one tool call and render the result as text for the model.
///
/// Never fails: a failed tool becomes an error string the model can speak
/// ("I couldn't check that because…"), which is far better in a live call than a
/// silent session or a dropped turn.
async fn execute_tool(
    tools: Arc<ToolSet>,
    name: String,
    arguments_json: String,
    options: Arc<RealtimeToolsOptions>,
    render: Option<RenderLoad>,
) -> String {
    let Some(execute) = tools.get(&name).and_then(|tool| tool.execute.clone()) else {
        return json!({ "error": format!("Unknown tool: {name}") }).to_string();
    };

    let args: Value = if crate::support::js::trim(&arguments_json).is_empty() {
        json!({})
    } else {
        match serde_json::from_str(&arguments_json) {
            Ok(args) => args,
            Err(_) => {
                return json!({ "error": format!("Invalid JSON arguments for {name}") })
                    .to_string();
            }
        }
    };

    log_info!("[{}] Executing tool {}", options.label, name);
    // The call context a chat turn would pass: built-in tools ignore it and MCP tools read
    // only the cancellation. A fresh token keeps the shape valid without promising a
    // cancellation this path does not have.
    let result = execute(
        args,
        ToolExecutionOptions {
            tool_call_id: format!(
                "{}-{}",
                options.label.to_lowercase(),
                crate::support::now_ms()
            ),
            messages: Arc::new(Vec::new()),
            abort_signal: Some(CancellationToken::new()),
            context: Value::Null,
        },
    )
    .await;

    match result {
        Ok(result) => {
            if let Some(render) = render {
                return render(serde_json::from_value(result).unwrap_or_default());
            }
            // The same store chat uses, so a call's saved outputs are read back the same
            // way and swept by the same janitor.
            render_and_spill(
                &result,
                &ToolOutputCaptureOptions {
                    max_chars: Some(MAX_TOOL_RESULT_CHARS),
                    extra_guidance: Some(options.truncation_guidance.clone()),
                    ..Default::default()
                },
                Some(&name),
            )
            .await
            .text
        }
        Err(err) => {
            let message = err.to_string();
            log_warn!("[{}] Tool {} failed: {}", options.label, name, message);
            json!({ "error": message }).to_string()
        }
    }
}
