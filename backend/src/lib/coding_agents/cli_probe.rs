//! One short command of a coding agent's CLI, run for its answer: a login
//! status, read before a task starts.

use tokio_util::sync::CancellationToken;

use crate::lib::execution_environments::capture::{CaptureOptions, CaptureResult, capture_program};
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};

/// How long the CLI gets to answer before the probe gives up on it.
pub const PROBE_TIMEOUT_MS: u64 = 10_000;

/// Enough for a status and whatever else the CLI prints around it.
pub const PROBE_OUTPUT_LIMIT: usize = 64 * 1024;

/// Run `command` in the environment where the binary and its home are, and
/// return what it printed for the caller to read. Fails when it does not start
/// (`<name> failed: <error>`) or does not answer in time
/// (`<name> did not answer in 10 s`), naming it by its command and the
/// arguments before the first flag.
pub async fn probe_cli(
    environment: &dyn ExecutionEnvironment,
    command: &str,
    args: &[String],
    env: ProcessEnv,
    signal: Option<CancellationToken>,
) -> anyhow::Result<CaptureResult> {
    let name = probe_name(command, args);
    let run = capture_program(
        environment,
        command,
        args,
        CaptureOptions {
            cwd: environment.workspace_root(),
            env,
            timeout_ms: PROBE_TIMEOUT_MS,
            limit_bytes: PROBE_OUTPUT_LIMIT,
            abort_signal: signal,
        },
    )
    .await;
    if let Some(error) = &run.error {
        anyhow::bail!("{name} failed: {error}");
    }
    if run.timed_out {
        anyhow::bail!("{name} did not answer in {} s", PROBE_TIMEOUT_MS / 1000);
    }
    Ok(run)
}

/// The command and its words up to the first flag: `claude auth status`.
pub fn probe_name(command: &str, args: &[String]) -> String {
    let words = match args.iter().position(|arg| arg.starts_with('-')) {
        Some(first_flag) => &args[..first_flag],
        None => args,
    };
    std::iter::once(command)
        .chain(words.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ")
}
