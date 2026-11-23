//! The coding-agent contract: what the runtime needs from a coding agent to
//! delegate a task to it, and nothing about how the agent is run.
//!
//! An adapter (one folder per agent, `get_coding_agent` selects it from
//! credentials) gives the agent a home at boot and runs each task end to end:
//! it launches the agent however that agent is launched, reads whatever the
//! agent emits, and reports it as the neutral events below. The task manager in
//! `tools::shell::agent_task_manager` buffers those events for the model's
//! polls, so a new agent is one adapter and no change to the tools.

use std::sync::Arc;

use async_trait::async_trait;
use futures::stream::BoxStream;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::config::CodingAgentName;
use crate::lib::execution_environments::execution_environment::{ProcessEnv, ProcessMark};

#[async_trait]
pub trait CodingAgent: Send + Sync {
    /// The adapter identifier.
    fn id(&self) -> CodingAgentName;
    /// The name shown to the model in the tool description and in the startup log.
    fn display_name(&self) -> &str;
    /// Boot-time setup: a home for the agent in the execution environment that
    /// shares that environment's skills dir, so both work from one set of skills.
    /// Asynchronous because the environment's filesystem may not be this
    /// process's own.
    async fn prepare_home(&self) -> anyhow::Result<CodingAgentHome>;
    /// Whether this agent has what it needs to run: its own credential rules,
    /// answered against the execution environment, since that is where its binary
    /// and its saved login are. Asked once at boot — see `availability`.
    async fn is_available(&self, env: &ProcessEnv) -> anyhow::Result<bool>;
    /// Start one task. Never fails for a launch failure: that arrives as the
    /// run's closing `result` event, so the caller has one path for every outcome.
    fn run(&self, task: CodingAgentTask) -> Arc<dyn CodingAgentRun>;
}

/// Plan mode's read-only promise, stated to the agent's model. Where the CLI does
/// not enforce plan mode, it is the whole promise.
pub const PLAN_ONLY_INSTRUCTION: &str = "You are in plan mode: analyze and plan only. Do not create, modify or delete any files, do not run commands that change state (installs, commits, pushes, deployments), and do not call tools that create, change or delete anything in another system (tickets, comments, pages, pull requests).";

/// `plan` analyzes only; `edit` may change files and run commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodingAgentMode {
    #[default]
    Edit,
    Plan,
}

impl CodingAgentMode {
    pub fn as_str(self) -> &'static str {
        match self {
            CodingAgentMode::Edit => "edit",
            CodingAgentMode::Plan => "plan",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelTier {
    Small,
    Medium,
    Large,
}

impl ModelTier {
    pub fn as_str(self) -> &'static str {
        match self {
            ModelTier::Small => "small",
            ModelTier::Medium => "medium",
            ModelTier::Large => "large",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CodingAgentTask {
    /// The manager's id for the task, for log correlation.
    pub task_id: String,
    pub prompt: String,
    pub workdir: Option<String>,
    /// The environment the agent inherits; the manager supplies the shell sandbox's.
    pub env: ProcessEnv,
    /// `Plan` analyzes only; `Edit` may change files and run commands.
    pub mode: CodingAgentMode,
    pub model_tier: Option<ModelTier>,
    pub effort: Option<Effort>,
    pub max_turns: i64,
    /// Extra instructions for the agent, kept alongside its own defaults.
    pub append_system_prompt: Option<String>,
    /// A session id an earlier run reported, to resume its context.
    pub session_id: Option<String>,
    pub debug: Option<bool>,
    /// The MCP servers the runtime connects for the agent, for the adapter to give its agent.
    pub mcp_servers: Vec<CodingAgentMcpServer>,
}

/// One MCP server, with its values as the runtime uses them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CodingAgentMcpServer {
    Stdio {
        name: String,
        command: String,
        args: Vec<String>,
        env: IndexMap<String, String>,
        /// The directory the server starts in.
        cwd: String,
    },
    Http {
        name: String,
        url: String,
        headers: IndexMap<String, String>,
    },
    Sse {
        name: String,
        url: String,
        headers: IndexMap<String, String>,
    },
}

impl CodingAgentMcpServer {
    pub fn name(&self) -> &str {
        match self {
            CodingAgentMcpServer::Stdio { name, .. }
            | CodingAgentMcpServer::Http { name, .. }
            | CodingAgentMcpServer::Sse { name, .. } => name,
        }
    }

    /// `stdio`, `http` or `sse`.
    pub fn kind(&self) -> &'static str {
        match self {
            CodingAgentMcpServer::Stdio { .. } => "stdio",
            CodingAgentMcpServer::Http { .. } => "http",
            CodingAgentMcpServer::Sse { .. } => "sse",
        }
    }
}

/// The agent's events in order, read once by the one consumer of a run.
pub type CodingAgentEvents = BoxStream<'static, CodingAgentEvent>;

/// One task's run. Held as `Arc<dyn CodingAgentRun>`.
#[async_trait]
pub trait CodingAgentRun: Send + Sync {
    /// The agent's events in order. The stream ends with exactly one `Result`,
    /// also when the agent failed to start or exited without reporting one.
    /// Taken once; a second call returns `None`.
    fn take_events(&self) -> Option<CodingAgentEvents>;
    /// True once the agent has exited.
    fn exited(&self) -> bool;
    /// Names the agent's process to the next boot, which stops it when a crash
    /// left it running. `None` until the process starts, and where the
    /// environment names none.
    fn mark(&self) -> Option<ProcessMark>;
    /// Settles when the agent's process starts, so `mark` names it from then on.
    /// Pending for a run that starts none.
    async fn started(&self);
    /// Ask the run to end, gracefully first and then forced. The stream still
    /// ends with a `Result`.
    fn stop(&self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodingAgentStopReason {
    EndTurn,
    MaxTurns,
    Error,
}

impl CodingAgentStopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            CodingAgentStopReason::EndTurn => "end_turn",
            CodingAgentStopReason::MaxTurns => "max_turns",
            CodingAgentStopReason::Error => "error",
        }
    }
}

/// An action the agent's own permission checks refused during a run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodingAgentRefusal {
    /// The tool or operation, in the agent's own name for it.
    pub action: String,
    /// What the action was aimed at: a path, a command, or its input.
    pub target: String,
}

/// The tokens one model spent on a task, as the agent reported them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingAgentUsage {
    pub model: String,
    /// The uncached part of the prompt.
    pub input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// The part of `cache_write_tokens` written with the one-hour lifetime.
    pub long_cache_write_tokens: i64,
    pub output_tokens: i64,
    /// The cost the agent reported for these tokens, in US dollars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    /// The run is billed to a subscription, not per token.
    pub subscription: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum CodingAgentEvent {
    /// Output for the caller, streamed as it is produced.
    Text { text: String },
    /// Tokens spent, reported when the agent reports them: once a run, or once a turn.
    Usage { usage: CodingAgentUsage },
    /// The id a later task passes as `session_id` to resume this one's context.
    Session {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// The outcome. `message` is the agent's own closing text: its answer, or what
    /// went wrong. `refusals` lists the actions the agent's permission checks refused.
    Result {
        #[serde(rename = "stopReason")]
        stop_reason: CodingAgentStopReason,
        turns: i64,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        refusals: Option<Vec<CodingAgentRefusal>>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingAgentHome {
    pub config_dir: String,
    /// Whether the agent reads the runtime's skills dir.
    pub skills_linked: bool,
}
