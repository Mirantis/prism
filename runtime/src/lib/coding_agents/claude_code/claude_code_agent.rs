//! Claude Code as a coding agent.
//!
//! Runs the `claude` CLI with `--output-format stream-json` and reads its NDJSON
//! stream back as the neutral events of `CodingAgent`. With the subscription on
//! (`subscription_switch`), every task runs on the Claude subscription signed in
//! to the CLI's home. Otherwise auth inherits from the runtime's environment:
//! the CLI picks up the same Bedrock or Anthropic credentials the agent itself
//! uses.
//!
//! Its home is the execution environment's `claude_home`, pointed at through
//! `CLAUDE_CONFIG_DIR`, so the CLI's own state (sessions, `.claude.json`) stays
//! out of the data-dir root and the user's real `~/.claude` is never touched.
//! The CLI discovers skills under `$CLAUDE_CONFIG_DIR/skills`, a symlink to the
//! environment's skills dir: both read the same bytes. Its MCP servers are the
//! runtime's own, given in a config file written for each task (`mcp_config`).

use std::sync::Arc;

use async_trait::async_trait;
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value;

use crate::config::CodingAgentName;
use crate::lib::coding_agents::coding_agent::{
    CodingAgent, CodingAgentEvent, CodingAgentHome, CodingAgentRefusal, CodingAgentRun,
    CodingAgentStopReason, CodingAgentTask,
};
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};

pub const DISPLAY_NAME: &str = "Claude Code";
pub const COMMAND: &str = "claude";

/// The input fields that name what a refused tool call was aimed at, most specific first.
pub const TARGET_FIELDS: &[&str] = &[
    "file_path",
    "notebook_path",
    "command",
    "url",
    "path",
    "pattern",
];

/// A refused call's target is cut here: a shell command can be a whole script.
pub const MAX_TARGET_CHARS: usize = 200;

/// One tool call the CLI's permission checks refused, as the `result` line lists it.
#[derive(Debug, Clone, Deserialize)]
pub struct PermissionDenial {
    pub tool_name: String,
    #[serde(default)]
    pub tool_input: IndexMap<String, Value>,
}

/// One content block of an `assistant` line.
#[derive(Debug, Clone, Deserialize)]
pub struct StreamContentBlock {
    #[serde(default, rename = "type")]
    pub block_type: Option<String>,
    #[serde(default)]
    pub text: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StreamMessage {
    #[serde(default)]
    pub content: Option<Vec<StreamContentBlock>>,
}

/// One line of `--output-format stream-json`.
#[derive(Debug, Clone, Deserialize)]
pub struct StreamLine {
    #[serde(default, rename = "type")]
    pub line_type: Option<String>,
    /// On the opening `system`/`init` line: what the CLI really started with.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, rename = "permissionMode")]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub message: Option<StreamMessage>,
    #[serde(default)]
    pub subtype: Option<String>,
    #[serde(default)]
    pub is_error: Option<bool>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub num_turns: Option<i64>,
    #[serde(default)]
    pub session_id: Option<Value>,
    #[serde(default)]
    pub permission_denials: Option<Vec<PermissionDenial>>,
}

/// The permission mode a task asks the CLI for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    Plan,
    Auto,
    BypassPermissions,
}

impl PermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::Plan => "plan",
            PermissionMode::Auto => "auto",
            PermissionMode::BypassPermissions => "bypassPermissions",
        }
    }
}

pub struct ClaudeCodeAgent {
    /// A test hook; production runs the real binary in the selected environment.
    environment: Option<Arc<dyn ExecutionEnvironment>>,
}

/// The optional environment is a test hook; production runs the real binary.
pub fn create_claude_code_agent(
    environment: Option<Arc<dyn ExecutionEnvironment>>,
) -> Arc<dyn CodingAgent> {
    Arc::new(ClaudeCodeAgent { environment })
}

#[async_trait]
impl CodingAgent for ClaudeCodeAgent {
    fn id(&self) -> CodingAgentName {
        CodingAgentName::ClaudeCode
    }

    fn display_name(&self) -> &str {
        DISPLAY_NAME
    }

    /// The environment's `claude_home`, unless `CLAUDE_CONFIG_DIR` names it.
    async fn prepare_home(&self) -> anyhow::Result<CodingAgentHome> {
        todo!()
    }

    async fn is_available(&self, env: &ProcessEnv) -> anyhow::Result<bool> {
        todo!()
    }

    /// A deferred run: with the subscription on, the home's login is asked first
    /// and anything but a subscription login fails the task with
    /// `not_signed_in_message` (naming the host home for a folder outside the
    /// deployment's environment); then the CLI starts, through
    /// `start_with_mcp_config` when the task has MCP servers.
    fn run(&self, task: CodingAgentTask) -> Arc<dyn CodingAgentRun> {
        todo!()
    }
}

/// The permission mode a task asks the CLI for. The bypass is for edit tasks the
/// operator runs where nothing else needs to check them; a plan task stays read-only.
fn permission_mode_for(task: &CodingAgentTask) -> PermissionMode {
    todo!()
}

/// `-p <prompt> --output-format stream-json --verbose --max-turns <n>`, the
/// permission flags, `--settings` on the subscription, `--append-system-prompt`
/// with the plan instruction and the caller's text joined by a blank line,
/// `--model` and `--effort` only when the task names them, `--resume`,
/// `--disallowed-tools AskUserQuestion`, `--mcp-config`, `--strict-mcp-config`
/// and `--debug`, in that order.
fn build_args(
    task: &CodingAgentTask,
    on_bedrock: bool,
    subscription: bool,
    mcp_config_path: Option<&str>,
) -> Vec<String> {
    todo!()
}

/// One stream line to events. Warns when the opening `init` line reports a
/// permission mode other than the task's.
fn parse_line(line: &str, task: &CodingAgentTask) -> anyhow::Result<Vec<CodingAgentEvent>> {
    todo!()
}

fn stop_reason_of(line: &StreamLine) -> CodingAgentStopReason {
    if line.subtype.as_deref() == Some("error_max_turns") {
        return CodingAgentStopReason::MaxTurns;
    }
    // A failed model call ends the run with subtype `success` and `is_error` set.
    if line.subtype.as_deref() == Some("success") && line.is_error != Some(true) {
        return CodingAgentStopReason::EndTurn;
    }
    CodingAgentStopReason::Error
}

/// The tool and the first string field of `TARGET_FIELDS` (else the input as
/// JSON), whitespace folded to one line and cut at `MAX_TARGET_CHARS` with `…`.
fn refusal_of(denial: &PermissionDenial) -> CodingAgentRefusal {
    todo!()
}
