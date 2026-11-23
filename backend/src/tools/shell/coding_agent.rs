//! `coding_agent` + `coding_agent_status` + `coding_agent_stop` tools —
//! in-process port of the upstream Mirantis Agent Platform handlers.
//!
//! The agent dispatches a task with `coding_agent({ prompt, ... })`, gets back
//! a `taskId`, then polls `coding_agent_status({ taskId })` for drain-on-read
//! output + completion. `coding_agent_stop({ taskId })` abandons a task that is
//! no longer worth waiting out.
//!
//! The available credentials select the coding agent
//! (`lib::coding_agents`); the sub-agent inherits the runtime's environment.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::agent_task_manager::{
    AgentTaskParams, AgentTaskStatus, StartedTask, get_agent_task_manager,
};
use super::workspace::resolve_path;
use crate::config::{CODING_AGENTS, CONFIG, CodingAgentName};
use crate::lib::coding_agents::coding_agent::{CodingAgentMode, Effort, ModelTier};
use crate::services::task_notification_service::TaskNotificationTarget;

/// The input of `coding_agent`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingAgentInput {
    /// Sub-agent to use.
    #[serde(default)]
    pub agent: Option<CodingAgentName>,
    /// The task for the sub-agent to perform.
    pub prompt: String,
    /// Model tier for this task.
    #[serde(default)]
    pub model: Option<ModelTier>,
    /// Reasoning effort for this task.
    #[serde(default)]
    pub effort: Option<Effort>,
    /// Working directory. Relative paths resolve from the workspace root;
    /// absolute paths pass through.
    #[serde(default)]
    pub workdir: Option<String>,
    /// Extra instructions appended to the sub-agent's default system prompt.
    #[serde(default)]
    pub append_system_prompt: Option<String>,
    #[serde(default)]
    pub mode: Option<CodingAgentMode>,
    /// Claude Code turn limit (default: 100, max: 200).
    #[serde(default)]
    pub max_turns: Option<i64>,
    /// Session ID from a previous coding_agent call to resume context.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Enable debug logging.
    #[serde(default)]
    pub debug: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingAgentStatusInput {
    /// Task ID returned by coding_agent.
    pub task_id: String,
    /// Max ms to wait for new output if none is buffered (default: 5000).
    #[serde(default)]
    pub wait_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingAgentStopInput {
    /// Task ID returned by coding_agent.
    pub task_id: String,
}

/// Built per tool set rather than once: which agents are available is settled by
/// a boot probe, which runs after start. The `agent` enum stays the
/// compile-time list; only its description is derived
/// (`Sub-agent to use. Available values: <list, or none detected>. Default:
/// <agent>. Use the same agent when resuming a session.`), and it is stable for
/// the rest of the process once the probe has settled — which is what the
/// prompt cache needs.
pub fn build_coding_agent_input_schema() -> Value {
    let agents: Vec<&str> = CODING_AGENTS.iter().map(|agent| agent.as_str()).collect();
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "agent": {
                "description": format!(
                    "Sub-agent to use. Available values: {}. Default: {}. Use the same agent when resuming a session.",
                    available_agents(),
                    CONFIG.coding_agent().as_str()
                ),
                "type": "string",
                "enum": agents
            },
            "prompt": {
                "type": "string",
                "description": "The task for the sub-agent to perform"
            },
            "model": {
                "description": "Model tier for this task. Small is for mechanical work and focused reads. Medium is for routine work and investigation. Large is for cross-cutting analysis and design. Omit to keep the deployment model.",
                "type": "string",
                "enum": ["small", "medium", "large"]
            },
            "effort": {
                "description": "Reasoning effort for this task. Low is for straightforward tasks with clear steps. Medium is for tasks that need some investigation. High is for difficult reasoning and complex tradeoffs. Omit to keep the deployment effort.",
                "type": "string",
                "enum": ["low", "medium", "high"]
            },
            "workdir": {
                "description": "Working directory. Relative paths resolve from the workspace root; absolute paths pass through.",
                "type": "string"
            },
            "appendSystemPrompt": {
                "description": "Extra instructions appended to the sub-agent's default system prompt. Its built-in tool, todo and search conventions are always kept.",
                "type": "string"
            },
            "mode": {
                "description": "\"edit\" (default) can create and change files. \"plan\" tells the sub-agent to analyze and report without changing anything. Pass sessionId from plan to edit to preserve context.",
                "type": "string",
                "enum": ["edit", "plan"]
            },
            "maxTurns": {
                "description": "Claude Code turn limit (default: 100, max: 200). Codex runs one task to completion; use coding_agent_stop to cancel.",
                "type": "integer",
                "minimum": 1,
                "maximum": 200
            },
            "sessionId": {
                "description": "Session ID from a previous coding_agent call to resume context. Pass this when transitioning plan \u{2192} edit.",
                "type": "string"
            },
            "debug": {
                "description": "Enable debug logging",
                "type": "boolean"
            }
        },
        "required": ["prompt"],
        "additionalProperties": false
    })
}

/// The available agents joined by `, `, or `none detected`.
pub fn available_agents() -> String {
    let available = CONFIG.available_coding_agents();
    if available.is_empty() {
        return "none detected".to_string();
    }
    available
        .iter()
        .map(|agent| agent.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn coding_agent_status_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "taskId": {
                "type": "string",
                "description": "Task ID returned by coding_agent"
            },
            "waitMs": {
                "description": "Max ms to wait for new output if none is buffered (default: 5000)",
                "type": "integer",
                "minimum": 0,
                "maximum": 30000
            }
        },
        "required": ["taskId"],
        "additionalProperties": false
    })
}

pub fn coding_agent_stop_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "taskId": {
                "type": "string",
                "description": "Task ID returned by coding_agent"
            }
        },
        "required": ["taskId"],
        "additionalProperties": false
    })
}

/// Resolves `workdir` against the workspace and starts the task.
/// What the agent does after starting a task whose result comes back as a task notification.
pub const NOTIFIED_TASK_NEXT: &str = "End your turn now unless you have other work. The result arrives in this conversation as a task notification when the task ends.";

/// What `coding_agent` returns: the started task, and in a chat conversation what
/// the agent does next.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingAgentStarted {
    #[serde(flatten)]
    pub task: StartedTask,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<&'static str>,
}

pub async fn run_coding_agent(
    input: CodingAgentInput,
    workspace: &str,
    notify: Option<TaskNotificationTarget>,
) -> anyhow::Result<CodingAgentStarted> {
    let workdir = match input.workdir.as_deref().filter(|dir| !dir.is_empty()) {
        Some(dir) => resolve_path(workspace, dir),
        None => workspace.to_string(),
    };
    let params = AgentTaskParams {
        agent: input.agent,
        prompt: input.prompt,
        workdir: Some(workdir),
        append_system_prompt: input.append_system_prompt,
        mode: input.mode,
        model_tier: input.model,
        effort: input.effort,
        max_turns: input.max_turns,
        session_id: input.session_id,
        debug: input.debug,
        notify: notify.clone(),
        spend: None,
    };
    let task = get_agent_task_manager().start_task(params).await?;
    Ok(CodingAgentStarted {
        task,
        next: notify.map(|_| NOTIFIED_TASK_NEXT),
    })
}

pub async fn run_coding_agent_status(
    input: CodingAgentStatusInput,
) -> anyhow::Result<AgentTaskStatus> {
    get_agent_task_manager()
        .read_status(&input.task_id, input.wait_ms)
        .await
}

pub async fn run_coding_agent_stop(input: CodingAgentStopInput) -> anyhow::Result<AgentTaskStatus> {
    get_agent_task_manager().stop_task(&input.task_id).await
}
