//! Run a coding agent's CLI as one `CodingAgentRun`.
//!
//! Shared plumbing for the adapters whose agent is a command-line program: start
//! it in the execution environment, turn each stdout line into events through
//! the adapter's parser, wait for it to exit, and close the stream with a
//! `result` when the agent reported none. The contract in `coding_agent` knows
//! nothing of this; an adapter that is not a CLI builds its run another way.

use std::sync::Arc;

use async_trait::async_trait;

use super::coding_agent::{CodingAgentEvent, CodingAgentEvents, CodingAgentRun};
use crate::lib::execution_environments::execution_environment::{
    ExecError, ExecProcess, ExecutionEnvironment, ProcessEnv, ProcessMark,
};

/// How long a stopped process gets to honour SIGTERM before SIGKILL.
pub const STOP_GRACE_MS: u64 = 2_000;

/// How much of stderr is kept for the closing message of a run that reports nothing.
pub const STDERR_KEEP_BYTES: usize = 4096;

/// One stdout line to events; `[]` for a line of no interest. Fails on a line
/// it cannot read, which is logged (`[AgentTask] unreadable output line`) and skipped.
pub type ParseLine = Box<dyn FnMut(&str) -> anyhow::Result<Vec<CodingAgentEvent>> + Send>;

pub struct CliRunSpec {
    pub task_id: String,
    /// Names the agent in the closing message of a run that never got to report.
    pub display_name: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: ProcessEnv,
    pub parse_line: ParseLine,
}

/// Start the CLI with `stdin: Pipe`, closing stdin at once (prompts are argv
/// inputs; Codex also reads piped stdin until EOF), and pump its output into the
/// run's events.
///
/// `environment` is resolved per path when `None`
/// (`get_execution_environment_for(spec.cwd)`), so a task in a repository the
/// container cannot see runs on the host — the same rule the shell tools follow.
/// An environment has no ambient working directory of its own, so a spec that
/// names none runs at the workspace root.
pub fn run_cli(
    spec: CliRunSpec,
    environment: Option<Arc<dyn ExecutionEnvironment>>,
) -> Arc<dyn CodingAgentRun> {
    todo!()
}

/// A CLI process as a run.
pub struct CliRun {
    pub(crate) proc: Arc<dyn ExecProcess>,
    pub(crate) task_id: String,
    pub(crate) events: parking_lot::Mutex<Option<CodingAgentEvents>>,
}

#[async_trait]
impl CodingAgentRun for CliRun {
    fn take_events(&self) -> Option<CodingAgentEvents> {
        self.events.lock().take()
    }

    fn exited(&self) -> bool {
        self.proc.exit_code().is_some() || self.proc.signal().is_some()
    }

    fn mark(&self) -> Option<ProcessMark> {
        self.proc.mark()
    }

    /// The process starts with the run.
    async fn started(&self) {}

    fn stop(&self) {
        terminate(&self.proc, &self.task_id)
    }
}

/// The `result` message for a run that ended without the agent reporting one.
pub fn closing_message(
    display_name: &str,
    launch_error: Option<&ExecError>,
    exit_code: Option<i32>,
    stderr: &str,
) -> String {
    // It never ran, so "exited with code N" would be a fiction.
    if let Some(error) = launch_error {
        return format!("{display_name} failed to start: {error}");
    }
    let code = exit_code.unwrap_or(1);
    if stderr.is_empty() {
        format!("{display_name} exited with code {code} and no result")
    } else {
        format!("{display_name} exited with code {code}: {stderr}")
    }
}

/// SIGTERM, then escalate to SIGKILL if the process is still alive — the same
/// two-stage shape `shell_exec` uses for its timeout and cancel paths.
fn terminate(proc: &Arc<dyn ExecProcess>, task_id: &str) {
    todo!()
}
