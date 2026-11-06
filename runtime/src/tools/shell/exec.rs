//! `shell_exec` tool — in-process port of the upstream Lens Agents shell
//! sandbox's `shell_exec` handler.
//!
//! Runs a single shell command in the execution environment with a timeout.
//! Captures stdout + stderr (up to MAX_EXEC_OUTPUT_BYTES each) and
//! returns them alongside the exit code. Input schema + return shape
//! are identical to upstream so the agent's tool contract doesn't
//! change between modes.

use nix::sys::signal::Signal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// The input of `shell_exec`.
#[derive(Debug, Clone, Deserialize)]
pub struct ShellExecInput {
    /// The shell command to execute.
    pub command: String,
    /// Working directory (default: workspace root). Relative paths resolve from
    /// the workspace root; absolute paths are used as-is.
    #[serde(default)]
    pub workdir: Option<String>,
    /// Timeout in milliseconds (default: 30000). Max 20 minutes.
    #[serde(default)]
    pub timeout: Option<u64>,
    /// Maximum number of bytes to capture per stream.
    #[serde(default)]
    pub limit: Option<usize>,
}

/// The JSON Schema `shell_exec` declares, byte-identical to the TypeScript runtime's.
pub fn shell_exec_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
    /// Set when the run was killed because the turn was canceled mid-command.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aborted: Option<bool>,
}

/// Core exec path — exposed separately for testing without wiring
/// through the tool surface.
///
/// Per path: a thread rooted in a repository the container cannot see runs on
/// the host instead. A launch failure is `{ stdout: "", stderr: <error>,
/// exitCode: -1 }`; truncated output ends with
/// `\n... (truncated; exceeded <limit> bytes)`.
pub async fn run_shell_exec(
    input: ShellExecInput,
    workspace: &str,
    abort_signal: Option<CancellationToken>,
) -> ExecResult {
    todo!()
}

pub fn exit_code_of(exit_code: Option<i32>, signal: Option<Signal>) -> i32 {
    if let Some(code) = exit_code {
        return code;
    }
    match signal {
        Some(signal) => 128 + signal_number(signal),
        None => -1,
    }
}

fn signal_number(signal: Signal) -> i32 {
    match signal {
        Signal::SIGHUP => 1,
        Signal::SIGINT => 2,
        Signal::SIGQUIT => 3,
        Signal::SIGKILL => 9,
        Signal::SIGTERM => 15,
        _ => 0,
    }
}
