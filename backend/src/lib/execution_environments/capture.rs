//! Run one command in the execution environment and collect what it printed.
//!
//! The one place a bounded, timed, cancellable run is written: `shell_exec`
//! formats its own result out of this, and so does every probe that shells out
//! for a single answer. A process that outlives its call belongs to
//! `tools::shell::process_manager` instead, which streams rather than collects.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::sync::broadcast;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::execution_environment::{
    ExecError, ExecOutput, ExecProcess, ExecutionEnvironment, ProcessEnv, RunOptions, Signal,
    StdinMode,
};
use crate::lib::agent_processes::{AGENT_PROCESSES, AgentProcesses, AgentProcessesEvent};

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
    collect_on(&AGENT_PROCESSES, proc, options).await
}

/// `collect`, with the clock following `processes`' window.
async fn collect_on(
    processes: &AgentProcesses,
    proc: Arc<dyn ExecProcess>,
    options: CaptureOptions,
) -> CaptureResult {
    let out = read_capped(proc.take_stdout(), options.limit_bytes);
    let err = read_capped(proc.take_stderr(), options.limit_bytes);

    // The budget counts the time the command runs, so the clock stops while a
    // secure takeover holds the command stopped and restarts with what was left.
    let mut events = processes.subscribe();
    let mut events_open = true;
    let mut clock = Clock::new(Duration::from_millis(options.timeout_ms));
    if !processes.is_suspended() {
        clock.arm();
    }
    let mut timed_out = false;

    let mut aborted = false;
    let abort = options.abort_signal.clone();
    let mut abort_pending = abort.is_some();
    if abort.as_ref().is_some_and(CancellationToken::is_cancelled) {
        aborted = true;
        abort_pending = false;
        terminate(&proc);
    }

    // `closed` rather than `ended`: the result is the output, so it waits for the
    // pipes to drain as well.
    let closed = proc.closed();
    tokio::pin!(closed);
    let end = loop {
        let deadline = clock.deadline();
        tokio::select! {
            end = &mut closed => break end,
            _ = sleep_until(deadline), if deadline.is_some() => {
                timed_out = true;
                clock.fire();
                terminate(&proc);
            }
            event = events.recv(), if events_open => match event {
                Ok(AgentProcessesEvent::Suspend) => clock.pause(),
                Ok(AgentProcessesEvent::Resume) => clock.arm(),
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => events_open = false,
            },
            _ = cancelled(&abort), if abort_pending => {
                aborted = true;
                abort_pending = false;
                terminate(&proc);
            }
        }
    };

    let (stdout, stdout_truncated) = out.await.unwrap_or_default();
    let (stderr, stderr_truncated) = err.await.unwrap_or_default();
    CaptureResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        stdout_truncated,
        stderr_truncated,
        exit_code: end.exit_code,
        signal: end.signal,
        timed_out,
        aborted,
        error: end.error,
    }
}

/// SIGTERM, then escalate to SIGKILL if the process hasn't exited shortly
/// after. Shared by the timeout and the cancel paths.
fn terminate(proc: &Arc<dyn ExecProcess>) {
    proc.kill(Signal::SIGTERM);
    let proc = proc.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(KILL_GRACE_MS)).await;
        if proc.exit_code().is_none() {
            proc.kill(Signal::SIGKILL);
        }
    });
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

async fn cancelled(token: &Option<CancellationToken>) {
    match token {
        Some(token) => token.cancelled().await,
        None => std::future::pending().await,
    }
}

/// The run's time budget. Armed while the command runs; a pause keeps what was
/// left. One that has fired stays armed until a pause, as a fired timer does.
struct Clock {
    remaining: Duration,
    timer: Timer,
}

enum Timer {
    Unset,
    Armed { at: Instant, deadline: Instant },
    Fired { at: Instant },
}

impl Clock {
    fn new(budget: Duration) -> Self {
        Clock {
            remaining: budget,
            timer: Timer::Unset,
        }
    }

    fn arm(&mut self) {
        if !matches!(self.timer, Timer::Unset) {
            return;
        }
        let at = Instant::now();
        self.timer = Timer::Armed {
            at,
            deadline: at + self.remaining,
        };
    }

    fn pause(&mut self) {
        let at = match self.timer {
            Timer::Unset => return,
            Timer::Armed { at, .. } | Timer::Fired { at } => at,
        };
        self.timer = Timer::Unset;
        self.remaining = self.remaining.saturating_sub(at.elapsed());
    }

    fn fire(&mut self) {
        if let Timer::Armed { at, .. } = self.timer {
            self.timer = Timer::Fired { at };
        }
    }

    fn deadline(&self) -> Option<Instant> {
        match self.timer {
            Timer::Armed { deadline, .. } => Some(deadline),
            _ => None,
        }
    }
}

/// A capped reader over one output stream. It reads to the end, so the process
/// never blocks on a full pipe, and keeps the first `limit_bytes`.
fn read_capped(
    stream: Option<ExecOutput>,
    limit_bytes: usize,
) -> tokio::task::JoinHandle<(Vec<u8>, bool)> {
    tokio::spawn(async move {
        let mut buffer = Vec::new();
        let mut truncated = false;
        let Some(mut stream) = stream else {
            return (buffer, truncated);
        };
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => append_capped_chunk(&chunk[..n], &mut buffer, &mut truncated, limit_bytes),
            }
        }
        (buffer, truncated)
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::execution_environments::local::local_env::local_base_env;
    use crate::lib::execution_environments::local::local_process::run_local_shell;

    #[test]
    fn appends_within_the_cap() {
        let (mut buffer, mut truncated) = (Vec::new(), false);
        append_capped_chunk(b"hello", &mut buffer, &mut truncated, 100);
        assert_eq!(buffer, b"hello");
        assert!(!truncated);
    }

    #[test]
    fn keeps_the_partial_chunk_at_the_cap_boundary() {
        let (mut buffer, mut truncated) = (Vec::new(), false);
        append_capped_chunk(b"aaaa", &mut buffer, &mut truncated, 10);
        append_capped_chunk(b"bbbbbbbb", &mut buffer, &mut truncated, 10);
        // Cap is 10. First chunk ate 4, part of the second fills 6 more.
        assert_eq!(buffer, b"aaaabbbbbb");
        assert!(truncated);
    }

    #[test]
    fn drops_further_chunks_once_truncated() {
        let (mut buffer, mut truncated) = (Vec::new(), false);
        append_capped_chunk(b"aaaaaaaaaaaa", &mut buffer, &mut truncated, 5);
        assert!(truncated);
        append_capped_chunk(b"xxx", &mut buffer, &mut truncated, 5);
        assert_eq!(buffer, b"aaaaa");
    }

    #[test]
    fn handles_a_chunk_that_exactly_equals_the_remaining_capacity() {
        let (mut buffer, mut truncated) = (Vec::new(), false);
        append_capped_chunk(b"hello", &mut buffer, &mut truncated, 5);
        assert_eq!(buffer.len(), 5);
        assert!(!truncated);
    }

    fn options(timeout_ms: u64, abort: Option<CancellationToken>) -> CaptureOptions {
        CaptureOptions {
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            env: local_base_env(None),
            timeout_ms,
            limit_bytes: 10_000,
            abort_signal: abort,
        }
    }

    /// A command tracked by `processes`, as an environment would start it.
    fn start(processes: &AgentProcesses, command: &str) -> Arc<dyn ExecProcess> {
        let command = command.to_string();
        processes.track(
            Box::new(move || {
                run_local_shell(
                    &command,
                    RunOptions {
                        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                        env: local_base_env(None),
                        stdin: StdinMode::Ignore,
                    },
                    true,
                )
            }),
            false,
        )
    }

    #[tokio::test]
    async fn does_not_count_the_time_a_secure_takeover_holds_the_command_stopped() {
        // Longer stopped than the whole budget. The command needs 0.2 s of a 2 s budget,
        // which leaves a loaded host 1.8 s to start it and finish after the resume.
        let processes = Arc::new(AgentProcesses::new());
        let proc = start(&processes, "sleep 0.2; echo done");
        let run = tokio::spawn({
            let processes = processes.clone();
            async move { collect_on(&processes, proc, options(2_000, None)).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        processes.suspend();
        tokio::time::sleep(Duration::from_millis(3_000)).await;
        processes.resume();

        let result = run.await.unwrap();
        assert!(!result.timed_out);
        assert_eq!(result.stdout.trim(), "done");
    }

    #[tokio::test]
    async fn keeps_the_budget_when_a_second_takeover_suspends_the_command_again() {
        // 1.8 s of a 3 s budget are spent first, so a second subtraction would leave none.
        // The command needs 0.2 s after that, which leaves a loaded host 1 s to spare.
        let processes = Arc::new(AgentProcesses::new());
        let proc = start(&processes, "sleep 2; echo done");
        let run = tokio::spawn({
            let processes = processes.clone();
            async move { collect_on(&processes, proc, options(3_000, None)).await }
        });
        tokio::time::sleep(Duration::from_millis(1_800)).await;
        processes.suspend();
        processes.suspend();
        tokio::time::sleep(Duration::from_millis(1_200)).await;
        processes.resume();

        let result = run.await.unwrap();
        assert!(!result.timed_out);
        assert_eq!(result.stdout.trim(), "done");
    }

    #[tokio::test]
    async fn settles_a_command_canceled_while_a_secure_takeover_holds_it_stopped() {
        let processes = Arc::new(AgentProcesses::new());
        let proc = start(&processes, "sleep 37; echo x");
        let token = CancellationToken::new();
        let run = tokio::spawn({
            let processes = processes.clone();
            let token = token.clone();
            async move { collect_on(&processes, proc, options(30_000, Some(token))).await }
        });
        tokio::time::sleep(Duration::from_millis(150)).await;
        processes.suspend();
        token.cancel();
        // The forked `sleep` holds the output pipe, so only a signal to the whole
        // group lets the command end while it is stopped.
        let result = tokio::time::timeout(Duration::from_secs(10), run)
            .await
            .expect("settled")
            .unwrap();
        processes.resume();
        assert!(result.aborted);
    }

    #[tokio::test]
    async fn times_out_and_kills_a_command_past_its_budget() {
        let processes = AgentProcesses::new();
        let proc = start(&processes, "sleep 5");
        let result = collect_on(&processes, proc, options(200, None)).await;
        assert!(result.timed_out);
        assert_eq!(result.signal, Some(Signal::SIGTERM));
    }
}
