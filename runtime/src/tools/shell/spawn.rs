//! `shell_spawn` family — generic background-process control for the
//! agent. Distinct from `coding_agent` (which is its own dedicated tool
//! over a fixed CLI surface): this set lets the agent start arbitrary
//! long-running shell tasks (e.g. `npm run test`), feed them stdin,
//! drain accumulated stdout/stderr, and kill them — all without
//! blocking other tool calls.
//!
//! Port of the upstream Lens Agents shell sandbox's process handlers,
//! with the per-process state map living in `process_manager`.

use nix::sys::signal::Signal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::process_manager::DrainResult;

#[derive(Debug, Clone, Deserialize)]
pub struct ShellSpawnInput {
    /// The shell command to start as a background process.
    pub command: String,
    /// Working directory (default: workspace root).
    #[serde(default)]
    pub workdir: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStdinInput {
    /// Process ID returned by shell_spawn.
    pub process_id: String,
    /// Data to write to the process's stdin (raw, no automatic newline).
    pub data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStdoutInput {
    /// Process ID returned by shell_spawn.
    pub process_id: String,
    /// If true, drain stderr instead of stdout (default: false).
    #[serde(default)]
    pub drain_stderr: Option<bool>,
}

/// The signals `shell_kill` takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum KillSignal {
    #[serde(rename = "SIGTERM")]
    Sigterm,
    #[serde(rename = "SIGKILL")]
    Sigkill,
    #[serde(rename = "SIGINT")]
    Sigint,
    #[serde(rename = "SIGHUP")]
    Sighup,
}

impl KillSignal {
    pub fn signal(self) -> Signal {
        match self {
            KillSignal::Sigterm => Signal::SIGTERM,
            KillSignal::Sigkill => Signal::SIGKILL,
            KillSignal::Sigint => Signal::SIGINT,
            KillSignal::Sighup => Signal::SIGHUP,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellKillInput {
    /// Process ID returned by shell_spawn.
    pub process_id: String,
    /// Signal to send (default: SIGTERM).
    #[serde(default)]
    pub signal: Option<KillSignal>,
}

pub fn shell_spawn_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn shell_stdin_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn shell_stdout_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn shell_kill_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSpawnResult {
    pub process_id: String,
}

/// `{ ok: true }` or `{ error }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum ShellStdinResult {
    Ok { ok: bool },
    Error { error: String },
}

/// The drained output, or `{ error }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum ShellStdoutResult {
    Drained(DrainResult),
    Error { error: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShellKillResult {
    pub ok: bool,
}

/// Fails with the process manager's refusal when too many processes run.
pub async fn run_shell_spawn(
    input: ShellSpawnInput,
    workspace: &str,
) -> anyhow::Result<ShellSpawnResult> {
    todo!()
}

pub async fn run_shell_stdin(input: ShellStdinInput) -> ShellStdinResult {
    todo!()
}

pub async fn run_shell_stdout(input: ShellStdoutInput) -> ShellStdoutResult {
    todo!()
}

/// Don't reap on kill — the signal is async and the process may
/// ignore SIGTERM. The map entry is kept so:
///   - `running_count()` still sees it (MAX_PROCESSES isn't bypassed),
///   - the agent can still drain final output,
///   - the agent can re-call shell_kill with SIGKILL if needed.
///
/// The natural lifecycle (the end handler in `process_manager` sets
/// the exit code) takes the process out of the running count once it
/// actually exits; the entry is purged on the next drain after exit.
pub async fn run_shell_kill(input: ShellKillInput) -> ShellKillResult {
    todo!()
}
