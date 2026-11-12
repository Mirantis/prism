use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ai::json::js_stringify;
use crate::ai::{Tool, execute_fn, json_schema, tool};
use crate::log_info;
use crate::services::agent_workspace_service::SubagentInfo;
use crate::types::{InvokeMode, InvokeRequest, InvokeResponse};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subagent {
    pub name: String,
    pub description: String,
}

/// Runs one invocation for a subagent: `invoke` itself, injected so this module
/// never imports it.
pub type Invoker =
    Arc<dyn Fn(InvokeRequest) -> BoxFuture<'static, anyhow::Result<InvokeResponse>> + Send + Sync>;

/// The Task tool's description, as the model reads it.
const TASK_TOOL_DESCRIPTION: &str = "Launch a new agent to handle complex, multi-step tasks autonomously. Use a subagent whenever the task matches its description. Each invocation begins with a clean slate: the agent does not see this conversation, so give it clear and detailed instructions with all the context it needs, and say whether it should change anything or only research. Its output is not shown to the user, so tell the user the outcome.";

/// The Task tool's input schema, as the model reads it.
static TASK_TOOL_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "type": "object",
        "properties": {
            "description": {
                "description": "A short (3-5 word) description of the task",
                "type": "string",
            },
            "prompt": {
                "description": "The task for the agent to perform",
                "type": "string",
            },
            "subagent_type": {
                "description": "The type of specialized agent to use for this task",
                "type": "string",
            },
        },
        "required": ["description", "prompt", "subagent_type"],
        "additionalProperties": false,
    })
});

/// Create a Task tool that delegates work to subagents.
///
/// The factory captures the subagents list and an invoker function,
/// avoiding circular dependencies (task_tool doesn't import invoke).
///
/// `execute` logs `[TaskTool] Received task with input: <input JSON>`, finds the
/// subagent whose name is `subagent_type` (else returns
/// `{ error: "Unknown subagent type: \"<type>\". Available: <names joined by ', '>" }`),
/// logs `[TaskTool] Invoking subagent "<name>" (<id>)`, invokes it with
/// `{ userId, agentId: subagent.id, mode: 'subagent', prompt: "<description>\n<prompt>" }`,
/// logs `[TaskTool] Subagent "<name>" responded with: <response JSON> with <n> tool calls`,
/// and returns `{ response, toolCalls }`, each tool call reduced to `tool`,
/// `input`, `output`, `success` and `timestamp`. The stored record also has
/// `rendered`/`truncated` — bookkeeping for replay and for the UI, meaningless
/// to a model and pure noise in its prompt.
pub fn create_task_tool(subagents: Vec<SubagentInfo>, user_id: String, invoker: Invoker) -> Tool {
    let subagents = Arc::new(subagents);
    tool(Tool {
        description: Some(TASK_TOOL_DESCRIPTION.to_string()),
        input_schema: json_schema(TASK_TOOL_SCHEMA.clone()),
        execute: Some(execute_fn(move |input: Value, _options| {
            let subagents = subagents.clone();
            let user_id = user_id.clone();
            let invoker = invoker.clone();
            async move {
                log_info!(
                    "[TaskTool] Received task with input: {}",
                    js_stringify(&input)
                );
                let description = template_text(input.get("description"));
                let subagent_type = template_text(input.get("subagent_type"));
                let prompt = template_text(input.get("prompt"));

                let Some(subagent) = subagents.iter().find(|s| s.name == subagent_type) else {
                    let names: Vec<&str> = subagents.iter().map(|s| s.name.as_str()).collect();
                    return Ok(json!({
                        "error": format!(
                            "Unknown subagent type: \"{}\". Available: {}",
                            subagent_type,
                            names.join(", ")
                        ),
                    }));
                };

                log_info!(
                    "[TaskTool] Invoking subagent \"{}\" ({})",
                    subagent.name,
                    subagent.id
                );

                let result = invoker(InvokeRequest {
                    user_id,
                    agent_id: subagent.id.clone(),
                    mode: InvokeMode::Subagent,
                    prompt: format!("{description}\n{prompt}"),
                    ..Default::default()
                })
                .await?;

                log_info!(
                    "[TaskTool] Subagent \"{}\" responded with: {} with {} tool calls",
                    subagent.name,
                    js_stringify(&Value::String(result.response.clone())),
                    result.tool_calls.len()
                );

                // What the subagent did, as the parent model needs to see it. The
                // stored record also has `rendered`/`truncated`: bookkeeping for
                // replay and for the UI, meaningless to a model and noise in its prompt.
                let tool_calls: Vec<Value> = result
                    .tool_calls
                    .iter()
                    .map(|call| {
                        json!({
                            "tool": call.tool,
                            "input": call.input,
                            "output": call.output,
                            "success": call.success,
                            "timestamp": call.timestamp,
                        })
                    })
                    .collect();
                Ok(json!({
                    "response": result.response,
                    "toolCalls": tool_calls,
                }))
            }
        })),
        ..Default::default()
    })
}

/// A JSON input value as a template literal prints it: a string as itself, a
/// missing value as `undefined`.
fn template_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "null".to_string(),
        Some(other) => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::ToolExecutionOptions;
    use crate::types::ToolCallRecord;
    use parking_lot::Mutex;

    fn subagents() -> Vec<SubagentInfo> {
        vec![
            SubagentInfo {
                id: "sub-1".into(),
                name: "Research Bot".into(),
                description: "Researches topics".into(),
            },
            SubagentInfo {
                id: "sub-2".into(),
                name: "Code Bot".into(),
                description: "Writes code".into(),
            },
        ]
    }

    fn recording_invoker(response: InvokeResponse) -> (Invoker, Arc<Mutex<Vec<InvokeRequest>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_in = seen.clone();
        let invoker: Invoker = Arc::new(move |request| {
            seen_in.lock().push(request);
            let response = response.clone();
            Box::pin(async move { Ok(response) })
        });
        (invoker, seen)
    }

    fn reply(text: &str, tool_calls: Vec<ToolCallRecord>) -> InvokeResponse {
        InvokeResponse {
            response: text.into(),
            tool_calls,
            ..Default::default()
        }
    }

    async fn run(tool: &Tool, input: Value) -> Value {
        let execute = tool.execute.as_ref().expect("the Task tool executes");
        execute(input, ToolExecutionOptions::default())
            .await
            .unwrap()
    }

    #[test]
    fn sends_the_definition_the_fixture_holds() {
        let (invoker, _) = recording_invoker(reply("Subagent response", vec![]));
        let mut tools = crate::ai::ToolSet::new();
        tools.insert(
            "Task".to_string(),
            create_task_tool(subagents(), "user-1".into(), invoker),
        );
        crate::tools::schema_fixture::assert_matches_fixture("task", &tools);
    }

    #[test]
    fn has_a_description_and_an_execute() {
        let (invoker, _) = recording_invoker(reply("Subagent response", vec![]));
        let tool = create_task_tool(subagents(), "user-1".into(), invoker);
        assert_eq!(tool.description.as_deref(), Some(TASK_TOOL_DESCRIPTION));
        assert!(tool.execute.is_some());
    }

    #[tokio::test]
    async fn invokes_the_named_subagent() {
        let (invoker, seen) = recording_invoker(reply("Subagent response", vec![]));
        let tool = create_task_tool(subagents(), "user-1".into(), invoker);
        let result = run(
            &tool,
            json!({ "description": "Research AI", "prompt": "Find papers on AI", "subagent_type": "Research Bot" }),
        )
        .await;

        let requests = seen.lock();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].user_id, "user-1");
        assert_eq!(requests[0].agent_id, "sub-1");
        assert_eq!(requests[0].mode, InvokeMode::Subagent);
        assert_eq!(requests[0].prompt, "Research AI\nFind papers on AI");
        assert_eq!(
            result,
            json!({ "response": "Subagent response", "toolCalls": [] })
        );
    }

    #[tokio::test]
    async fn refuses_an_unknown_subagent() {
        let (invoker, seen) = recording_invoker(reply("Subagent response", vec![]));
        let tool = create_task_tool(subagents(), "user-1".into(), invoker);
        let result = run(
            &tool,
            json!({ "description": "Do stuff", "prompt": "Do something", "subagent_type": "Unknown Bot" }),
        )
        .await;

        assert!(seen.lock().is_empty());
        assert_eq!(
            result,
            json!({ "error": "Unknown subagent type: \"Unknown Bot\". Available: Research Bot, Code Bot" })
        );
    }

    #[tokio::test]
    async fn passes_the_reply_and_its_tool_calls_through_without_bookkeeping() {
        let call = ToolCallRecord {
            tool: "memory_search".into(),
            input: "{}".into(),
            output: "[]".into(),
            success: true,
            timestamp: "2026-01-01T00:00:00Z".into(),
            rendered: true,
            truncated: None,
        };
        let (invoker, _) = recording_invoker(reply("Found 3 papers.", vec![call]));
        let tool = create_task_tool(subagents(), "user-1".into(), invoker);
        let result = run(
            &tool,
            json!({ "description": "Research", "prompt": "Find papers", "subagent_type": "Research Bot" }),
        )
        .await;

        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            serde_json::to_string(&json!({
                "response": "Found 3 papers.",
                "toolCalls": [
                    { "tool": "memory_search", "input": "{}", "output": "[]", "success": true, "timestamp": "2026-01-01T00:00:00Z" },
                ],
            }))
            .unwrap()
        );
    }
}
