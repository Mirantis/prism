//! Run one command in the execution environment and collect what it printed.
//!
//! The one place a bounded, timed, cancellable run is written: `shell_exec`
//! formats its own result out of this, and so does every probe that shells out
//! for a single answer. A process that outlives its call belongs to
//! `tools::shell::process_manager` instead, which streams rather than collects.

use std::sync::Arc;

use nix::sys::signal::Signal;
use tokio_util::sync::CancellationToken;

use super::execution_environment::{
    ExecError, ExecProcess, ExecutionEnvironment, ProcessEnv, RunOptions, StdinMode,
};

#[derive(Debug, Clone)]
pub struct CaptureOptions {
    pub cwd: String,
    pub env: ProcessEnv,
    pub timeout_ms: u64,
    /// Bytes kept per stream; the rest is dropped and reported as truncated.
    pub limit_bytes: usize,
    /// Kills the process when the turn is canceled mid-command.
    pub abort_signal: Option<CancellationToken>,
}

#[derive(Debug, Clone)]
pub struct CaptureResult {
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub exit_code: Option<i32>,
    pub signal: Option<Signal>,
    /// The command ran past `timeout_ms` and was killed.
    pub timed_out: bool,
    /// The caller's signal fired and the command was killed.
    pub aborted: bool,
    /// Set when the command never started.
    pub error: Option<ExecError>,
}

/// How long a killed process gets to honour SIGTERM before SIGKILL.
pub const KILL_GRACE_MS: u64 = 2_000;

pub async fn capture_shell(
    environment: &dyn ExecutionEnvironment,
    command: &str,
    options: CaptureOptions,
) -> CaptureResult {
    let proc = environment.run_shell(
        command,
        RunOptions {
            cwd: options.cwd.clone(),
            env: options.env.clone(),
            stdin: StdinMode::Ignore,
        },
    );
    collect(proc, options).await
}

pub async fn capture_program(
    environment: &dyn ExecutionEnvironment,
    command: &str,
    args: &[String],
    options: CaptureOptions,
) -> CaptureResult {
    let proc = environment.run_program(
        command,
        args,
        RunOptions {
            cwd: options.cwd.clone(),
            env: options.env.clone(),
            stdin: StdinMode::Ignore,
        },
    );
    collect(proc, options).await
}

/// Read both streams up to the cap, time the run (the clock stops while a secure
/// takeover holds the command stopped and restarts with what was left), kill it
/// with SIGTERM then SIGKILL on a timeout or a cancel, and wait for `closed`: the
/// result is the output, so it waits for the pipes to drain as well.
async fn collect(proc: Arc<dyn ExecProcess>, options: CaptureOptions) -> CaptureResult {
    todo!()
}

/// Append a chunk to a capped buffer. A chunk that crosses the cap keeps the
/// part that fits, so the buffer holds exactly `cap` bytes once truncated.
pub fn append_capped_chunk(chunk: &[u8], buffer: &mut Vec<u8>, truncated: &mut bool, cap: usize) {
    if *truncated {
        return;
    }
    let remaining = cap.saturating_sub(buffer.len());
    if chunk.len() <= remaining {
        buffer.extend_from_slice(chunk);
    } else {
        if remaining > 0 {
            buffer.extend_from_slice(&chunk[..remaining]);
        }
        *truncated = true;
    }
}
