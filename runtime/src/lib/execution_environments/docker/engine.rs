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

use super::docker_process::host_cwd;
use crate::lib::execution_environments::capture::{CaptureOptions, CaptureResult, capture_program};
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};
use crate::lib::execution_environments::local::local_environment::create_local_environment;
use crate::support::js;

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
    let environment = host_environment();
    let mut env = environment.base_env();
    if let Some(extra) = options.env {
        env.extend(extra);
    }
    capture_program(
        environment.as_ref(),
        DOCKER,
        args,
        CaptureOptions {
            // This process's own directory, which is certain to exist. Where the
            // engine's client runs makes no difference to the subcommand, and the
            // agent's workspace is not a host path under every environment.
            cwd: host_cwd(),
            env,
            timeout_ms: options.timeout_ms,
            limit_bytes: CONTROL_OUTPUT_LIMIT,
            abort_signal: None,
        },
    )
    .await
}

fn host_environment() -> Arc<dyn ExecutionEnvironment> {
    if let Some(host) = HOST.read().as_ref() {
        return host.clone();
    }
    HOST.write()
        .get_or_insert_with(create_local_environment)
        .clone()
}

/// `engine_call` with string arguments.
pub async fn engine_call_args(args: &[&str], options: EngineCallOptions) -> CaptureResult {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    engine_call(&args, options).await
}

/// The engine's own report of a failed call, for a log line or an error.
pub fn engine_failure(command: &str, run: &CaptureResult) -> String {
    if let Some(error) = &run.error {
        return format!("{command}: {error}");
    }
    if run.timed_out {
        return format!("{command}: the engine did not answer in time");
    }
    let stderr = js::trim(&run.stderr);
    let said = if stderr.is_empty() {
        js::trim(&run.stdout)
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
