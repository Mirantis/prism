//! `coding_agent` + `coding_agent_status` + `coding_agent_stop` tools —
//! in-process port of the upstream Lens Agents handlers.
//!
//! The agent dispatches a task with `coding_agent({ prompt, ... })`, gets back
//! a `taskId`, then polls `coding_agent_status({ taskId })` for drain-on-read
//! output + completion. `coding_agent_stop({ taskId })` abandons a task that is
//! no longer worth waiting out.
//!
//! The available credentials select the coding agent
//! (`lib::coding_agents`); the sub-agent inherits the runtime's environment.

use serde::Deserialize;
use serde_json::Value;

use super::agent_task_manager::{AgentTaskStatus, StartedTask};
use crate::config::CodingAgentName;
use crate::lib::coding_agents::coding_agent::{CodingAgentMode, Effort, ModelTier};

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
    todo!("JSON Schema supplied by the coordinator")
}

pub fn coding_agent_status_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn coding_agent_stop_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

/// Resolves `workdir` against the workspace and starts the task.
pub async fn run_coding_agent(
    input: CodingAgentInput,
    workspace: &str,
) -> anyhow::Result<StartedTask> {
    todo!()
}

pub async fn run_coding_agent_status(
    input: CodingAgentStatusInput,
) -> anyhow::Result<AgentTaskStatus> {
    todo!()
}

pub async fn run_coding_agent_stop(input: CodingAgentStopInput) -> anyhow::Result<AgentTaskStatus> {
    todo!()
}
