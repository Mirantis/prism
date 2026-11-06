use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ai::Tool;
use crate::services::agent_workspace_service::SubagentInfo;
use crate::types::{InvokeRequest, InvokeResponse};

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
    todo!()
}
