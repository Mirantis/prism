//! The container engine, reached through its CLI.
//!
//! The CLI rather than the API socket because `docker` is also the front end for
//! Podman, Colima, Rancher Desktop and OrbStack, and it resolves `DOCKER_HOST`
//! and contexts on its own. That coverage is the whole reason: a developer
//! machine is as likely to be running Podman as Docker.
//!
//! Every call here runs on the **host** — this is the runtime talking to the
//! engine, not the agent running a command — so it goes through a local
//! environment of its own rather than whichever one the selector settled on.

use std::sync::Arc;

use parking_lot::RwLock;

use crate::lib::execution_environments::capture::CaptureResult;
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};

pub const DOCKER: &str = "docker";

/// Enough for `docker version`, an id, or an error; never a command's output.
pub const CONTROL_OUTPUT_LIMIT: usize = 64 * 1024;

/// The host, where the engine's client runs. Fixed, not the selected environment.
static HOST: RwLock<Option<Arc<dyn ExecutionEnvironment>>> = RwLock::new(None);

#[derive(Debug, Clone, Default)]
pub struct EngineCallOptions {
    pub timeout_ms: u64,
    /// Values for the `-e NAME` flags in `args`. The engine's client reads them
    /// from its own environment, so a token is never written into an argv that
    /// `ps` on the host can read.
    pub env: Option<ProcessEnv>,
}

/// Run one engine subcommand and collect what it said. Never fails: a launch
/// failure is the result's `error`.
///
/// Runs in this process's own directory, with the host environment's base env
/// plus `options.env`, and `CONTROL_OUTPUT_LIMIT` per stream.
pub async fn engine_call(args: &[String], options: EngineCallOptions) -> CaptureResult {
    todo!()
}

/// The engine's own report of a failed call, for a log line or an error.
pub fn engine_failure(command: &str, run: &CaptureResult) -> String {
    if let Some(error) = &run.error {
        return format!("{command}: {error}");
    }
    if run.timed_out {
        return format!("{command}: the engine did not answer in time");
    }
    let stderr = run.stderr.trim();
    let said = if stderr.is_empty() {
        run.stdout.trim()
    } else {
        stderr
    };
    if said.is_empty() {
        let code = run
            .exit_code
            .map(|c| c.to_string())
            .unwrap_or_else(|| "null".to_string());
        format!("{command}: exited {code}")
    } else {
        format!("{command}: {said}")
    }
}

/// Test-only: forget the host environment so a fake can stand in.
pub fn reset_engine_host_for_tests(environment: Option<Arc<dyn ExecutionEnvironment>>) {
    *HOST.write() = environment;
}
