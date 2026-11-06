//! Codex as a coding agent: `codex exec --json` read back as the neutral events
//! of `CodingAgent`.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use async_trait::async_trait;
use serde::Deserialize;

use super::credentials::CodexAuthMethod;
use crate::config::CodingAgentName;
use crate::lib::coding_agents::cli_run::ParseLine;
use crate::lib::coding_agents::coding_agent::{
    CodingAgent, CodingAgentHome, CodingAgentRun, CodingAgentTask,
};
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};

pub const DISPLAY_NAME: &str = "Codex";
pub const COMMAND: &str = "codex";

#[derive(Debug, Clone, Deserialize)]
pub struct StreamItem {
    #[serde(rename = "type")]
    pub item_type: String,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StreamError {
    pub message: String,
}

/// One line of `codex exec --json`.
#[derive(Debug, Clone, Deserialize)]
pub struct StreamLine {
    #[serde(rename = "type")]
    pub line_type: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub item: Option<StreamItem>,
    #[serde(default)]
    pub error: Option<StreamError>,
    #[serde(default)]
    pub message: Option<String>,
}

pub struct CodexAgent {
    /// A test hook; production runs in the selected environment.
    environment: Option<Arc<dyn ExecutionEnvironment>>,
    /// Read once, when availability is probed at boot: a task's argv is built
    /// synchronously and the home may be a round trip away.
    saved_login: AtomicBool,
}

pub fn create_codex_agent(
    environment: Option<Arc<dyn ExecutionEnvironment>>,
) -> Arc<dyn CodingAgent> {
    Arc::new(CodexAgent {
        environment,
        saved_login: AtomicBool::new(false),
    })
}

#[async_trait]
impl CodingAgent for CodexAgent {
    fn id(&self) -> CodingAgentName {
        CodingAgentName::Codex
    }

    fn display_name(&self) -> &str {
        DISPLAY_NAME
    }

    /// The environment's `codex_home`, unless `CODEX_HOME` names it.
    async fn prepare_home(&self) -> anyhow::Result<CodingAgentHome> {
        todo!()
    }

    /// Reads the saved login once, then whether any auth method applies.
    async fn is_available(&self, env: &ProcessEnv) -> anyhow::Result<bool> {
        todo!()
    }

    /// Emits `codex task started` now and `codex task finished` (with `status`
    /// the stop reason, or `stopped`, and `elapsed_ms`) when the events end. On
    /// the subscription the run is deferred until the home's login reads
    /// `chatgpt`; otherwise the CLI starts at once with `CODEX_API_KEY`.
    fn run(&self, task: CodingAgentTask) -> Arc<dyn CodingAgentRun> {
        todo!()
    }
}

/// `exec --json --skip-git-repo-check -c approval_policy="never" -c
/// sandbox_mode="danger-full-access"`, then the provider for the auth method,
/// `--model`, `model_reasoning_effort`, `developer_instructions`, `resume <id>`,
/// and `-- <mode instruction>\n\n<prompt>`.
///
/// Every task runs without Codex's sandbox: in an unprivileged container, the
/// deployed shape, the sandbox cannot start and every command in it fails.
/// Nothing can answer an approval request, so none is asked.
fn build_args(task: &CodingAgentTask, auth_method: Option<CodexAuthMethod>) -> Vec<String> {
    todo!()
}

/// Codex reports one turn for the whole exec task, including its tool calls.
/// The parser keeps the last answer and the last error between lines.
fn create_parser() -> ParseLine {
    todo!()
}
