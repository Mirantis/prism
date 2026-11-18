//! Process manager for the generic `shell_spawn` family.
//!
//! In-process map of background processes the execution environment started;
//! the agent uses this to start long-running tasks (e.g. `npm run test`), feed
//! them stdin, drain their stdout/stderr, and kill them.
//!
//! Port of the relevant bits of the upstream Mirantis Agent Platform shell sandbox's
//! process handlers, minus the cross-process MCP plumbing — the runtime
//! calls these directly from its tools.
//!
//! Concurrency cap is intentionally generous (10) because these are
//! agent-driven background tasks; the cap exists to prevent runaway
//! fork-bomb scenarios, not to gate user concurrency.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::lib::execution_environments::capture::append_capped_chunk;
use crate::lib::execution_environments::execution_environment::{
    ExecOutput, ExecProcess, ExecStdin, RunOptions, Signal, StdinMode,
};
use crate::lib::execution_environments::get_execution_environment::get_execution_environment_for;
use crate::lib::log_redaction::err_json;
use crate::log_error;

pub const MAX_PROCESSES: usize = 10;
/// 10 MiB per stream.
pub const MAX_OUTPUT_BUFFER: usize = 10 * 1024 * 1024;

/// One background process and what it has printed since the last drain.
pub struct ProcessState {
    pub proc: Arc<dyn ExecProcess>,
    /// What `stdin` writes, in order; `None` when the process took no stdin.
    pub stdin: Option<ProcessStdin>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub signal: Option<Signal>,
    /// Epoch milliseconds.
    pub started_at: i64,
}

/// A process's stdin as a write that never waits: the bytes queue and a writer
/// task hands them on, as a Node stream buffers its writes. A failed write marks
/// the stream destroyed.
pub struct ProcessStdin {
    queue: mpsc::UnboundedSender<Vec<u8>>,
    destroyed: Arc<AtomicBool>,
}

impl ProcessStdin {
    fn open(mut writer: ExecStdin) -> ProcessStdin {
        let (queue, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let destroyed = Arc::new(AtomicBool::new(false));
        let flag = destroyed.clone();
        tokio::spawn(async move {
            while let Some(data) = rx.recv().await {
                if writer.write_all(&data).await.is_err() || writer.flush().await.is_err() {
                    flag.store(true, Ordering::SeqCst);
                    return;
                }
            }
            let _ = writer.shutdown().await;
        });
        ProcessStdin { queue, destroyed }
    }

    fn destroyed(&self) -> bool {
        self.destroyed.load(Ordering::SeqCst)
    }

    fn write(&self, data: &str) -> Result<(), String> {
        self.queue
            .send(data.as_bytes().to_vec())
            .map_err(|_| "write after end".to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Truncated {
    pub stdout: bool,
    pub stderr: bool,
}

/// What `drain` hands back: the drained stream, and the process's state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    /// The signal's name (`SIGTERM`), `null` while running or after a normal exit.
    pub signal: Option<String>,
    pub running: bool,
    pub truncated: Truncated,
}

#[derive(Debug, Clone, Default)]
pub struct SpawnParams {
    pub command: String,
    pub workdir: String,
    pub env: Option<IndexMap<String, String>>,
}

#[derive(Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

pub struct ProcessManager {
    processes: Arc<Mutex<HashMap<String, ProcessState>>>,
}

impl ProcessManager {
    pub fn new() -> Self {
        ProcessManager {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawn a new background process. Returns the assigned process id.
    ///
    /// Fails with `Too many running processes (<n>/10). Kill some with
    /// shell_kill before spawning more.` at the cap. The process leads its own
    /// group, so a kill reaches the whole group and not only the shell wrapper.
    /// Exit accounting reads `ended` rather than `closed`: it settles when the
    /// process exits whether or not its stdio pipes are still open.
    pub fn spawn(&self, params: SpawnParams) -> anyhow::Result<String> {
        let running = self.running_count();
        if running >= MAX_PROCESSES {
            anyhow::bail!(
                "Too many running processes ({running}/{MAX_PROCESSES}). Kill some with shell_kill before spawning more."
            );
        }

        let process_id = uuid::Uuid::new_v4().to_string();
        let environment = get_execution_environment_for(Some(&params.workdir));
        let mut env = environment.base_env();
        if let Some(extra) = params.env {
            env.extend(extra);
        }
        let proc = environment.run_shell(
            &params.command,
            RunOptions {
                cwd: params.workdir,
                env,
                stdin: StdinMode::Pipe,
            },
        );

        let stdin = proc.take_stdin().map(ProcessStdin::open);
        let stdout = proc.take_stdout();
        let stderr = proc.take_stderr();
        self.processes.lock().insert(
            process_id.clone(),
            ProcessState {
                proc: proc.clone(),
                stdin,
                stdout: Vec::new(),
                stderr: Vec::new(),
                stdout_truncated: false,
                stderr_truncated: false,
                exited: false,
                exit_code: None,
                signal: None,
                started_at: crate::support::now_ms(),
            },
        );

        self.collect(&process_id, stdout, Stream::Stdout);
        self.collect(&process_id, stderr, Stream::Stderr);
        // `ended` rather than `closed`: it settles when the process exits whether
        // or not its stdio pipes are still open (they stay open if grandchildren
        // inherit them), and waiting for the pipes to drain would be too late for
        // our running/exit accounting.
        let processes = self.processes.clone();
        let id = process_id.clone();
        tokio::spawn(async move {
            let end = proc.ended().await;
            if let Some(state) = processes.lock().get_mut(&id) {
                state.exited = true;
                state.exit_code = end.exit_code;
                state.signal = end.signal;
            }
            if let Some(err) = end.error {
                log_error!(
                    json!({ "err": err_json(&err), "processId": id }),
                    "[ProcessManager] child error"
                );
            }
        });

        Ok(process_id)
    }

    /// Append what a stream prints to the process's buffer, up to the cap.
    fn collect(&self, process_id: &str, stream: Option<ExecOutput>, which: Stream) {
        let Some(mut stream) = stream else {
            return;
        };
        let processes = self.processes.clone();
        let id = process_id.to_string();
        tokio::spawn(async move {
            let mut chunk = vec![0u8; 64 * 1024];
            loop {
                let n = match stream.read(&mut chunk).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                };
                let mut processes = processes.lock();
                let Some(state) = processes.get_mut(&id) else {
                    continue;
                };
                match which {
                    Stream::Stdout => append_capped_chunk(
                        &chunk[..n],
                        &mut state.stdout,
                        &mut state.stdout_truncated,
                        MAX_OUTPUT_BUFFER,
                    ),
                    Stream::Stderr => append_capped_chunk(
                        &chunk[..n],
                        &mut state.stderr,
                        &mut state.stderr_truncated,
                        MAX_OUTPUT_BUFFER,
                    ),
                }
            }
        });
    }

    /// Write data to the process's stdin. Fails if the process is not running
    /// or its stdin has been closed (`Process <id> not found`,
    /// `Process <id> has already exited`, `Process <id> stdin is not writable`,
    /// `Process <id> stdin write failed: <reason>`).
    pub async fn stdin(&self, process_id: &str, data: &str) -> anyhow::Result<()> {
        let processes = self.processes.lock();
        let Some(state) = processes.get(process_id) else {
            anyhow::bail!("Process {process_id} not found");
        };
        if state.exited {
            anyhow::bail!("Process {process_id} has already exited");
        }
        let Some(stdin) = state.stdin.as_ref().filter(|stdin| !stdin.destroyed()) else {
            anyhow::bail!("Process {process_id} stdin is not writable");
        };
        // The process may have just died between the destroyed check and the
        // write — surface that as a clean error rather than failing the call site.
        stdin
            .write(data)
            .map_err(|reason| anyhow::anyhow!("Process {process_id} stdin write failed: {reason}"))
    }

    /// Drain accumulated stdout + stderr. By default returns and clears
    /// stdout only; pass `drain_stderr` to drain stderr instead.
    /// Returns the running flag and exit code/signal once the process
    /// has terminated.
    ///
    /// Reaps the entry after the agent reads the post-exit drain. The first
    /// such drain still returns a `running: false` snapshot; any subsequent
    /// shell_stdout / shell_kill on this id reports "not found", which is the
    /// correct lifecycle signal.
    pub fn drain(&self, process_id: &str, drain_stderr: bool) -> anyhow::Result<DrainResult> {
        let mut processes = self.processes.lock();
        let Some(state) = processes.get_mut(process_id) else {
            anyhow::bail!("Process {process_id} not found");
        };

        let mut stdout = String::new();
        let mut stderr = String::new();
        if !drain_stderr {
            stdout = String::from_utf8_lossy(&std::mem::take(&mut state.stdout)).into_owned();
        } else {
            stderr = String::from_utf8_lossy(&std::mem::take(&mut state.stderr)).into_owned();
        }

        let result = DrainResult {
            stdout,
            stderr,
            exit_code: state.exit_code,
            signal: state.signal.map(|signal| signal.as_str().to_string()),
            running: !state.exited,
            truncated: Truncated {
                stdout: state.stdout_truncated,
                stderr: state.stderr_truncated,
            },
        };

        if state.exited && state.stdout.is_empty() && state.stderr.is_empty() {
            processes.remove(process_id);
        }

        Ok(result)
    }

    /// Send a signal (SIGTERM by default) to the process group, so the shell
    /// wrapper's children get it too.
    pub fn kill(&self, process_id: &str, signal: Option<Signal>) -> bool {
        let proc = {
            let processes = self.processes.lock();
            match processes.get(process_id) {
                Some(state) if !state.exited => state.proc.clone(),
                _ => return false,
            }
        };
        proc.kill(signal.unwrap_or(Signal::SIGTERM))
    }

    /// Forget a process record (after termination + final drain).
    /// Doesn't kill — call `kill()` first if needed.
    pub fn reap(&self, process_id: &str) {
        self.processes.lock().remove(process_id);
    }

    /// Number of processes that haven't exited yet.
    pub fn running_count(&self) -> usize {
        self.processes.lock().values().filter(|s| !s.exited).count()
    }

    /// Kill everything (SIGTERM by default) and forget it (test cleanup).
    pub fn kill_all(&self, signal: Option<Signal>) {
        let signal = signal.unwrap_or(Signal::SIGTERM);
        let drained: Vec<ProcessState> = self
            .processes
            .lock()
            .drain()
            .map(|(_, state)| state)
            .collect();
        for state in drained {
            if !state.exited {
                state.proc.kill(signal);
            }
        }
    }

    #[cfg(test)]
    fn peek<T>(&self, process_id: &str, read: impl FnOnce(&ProcessState) -> T) -> Option<T> {
        self.processes.lock().get(process_id).map(read)
    }
}

impl Default for ProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

static PROCESS_MANAGER: LazyLock<ProcessManager> = LazyLock::new(ProcessManager::new);

pub fn get_process_manager() -> &'static ProcessManager {
    &PROCESS_MANAGER
}

/// Test-only: kill every process and forget it.
pub fn reset_process_manager_for_tests() {
    PROCESS_MANAGER.kill_all(Some(Signal::SIGKILL));
}

#[cfg(test)]
mod tests {
    //! The shell_spawn family against real subprocesses (cat, sleep, sh), so the
    //! process and its stdio pipeline are the real ones.

    use std::time::Duration;

    use super::super::spawn::{
        KillSignal, ShellKillInput, ShellKillResult, ShellSpawnInput, ShellStdinInput,
        ShellStdinResult, ShellStdoutInput, ShellStdoutResult, run_shell_kill, run_shell_spawn,
        run_shell_stdin, run_shell_stdout,
    };
    use super::*;

    fn workspace() -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix("spawn-tools-test-")
            .tempdir()
            .unwrap();
        let path = std::fs::canonicalize(dir.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        (dir, path)
    }

    async fn spawn(command: &str, ws: &str) -> String {
        run_shell_spawn(
            ShellSpawnInput {
                command: command.to_string(),
                workdir: None,
            },
            ws,
        )
        .await
        .unwrap()
        .process_id
    }

    async fn drain(process_id: &str, drain_stderr: bool) -> ShellStdoutResult {
        run_shell_stdout(ShellStdoutInput {
            process_id: process_id.to_string(),
            drain_stderr: Some(drain_stderr),
        })
        .await
    }

    async fn kill(process_id: &str, signal: Option<KillSignal>) -> ShellKillResult {
        run_shell_kill(ShellKillInput {
            process_id: process_id.to_string(),
            signal,
        })
        .await
    }

    async fn wait_for(check: impl Fn() -> bool, timeout_ms: u64) {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        while tokio::time::Instant::now() < deadline {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("wait_for timed out after {timeout_ms}ms");
    }

    fn manager() -> &'static ProcessManager {
        get_process_manager()
    }

    fn drained(result: ShellStdoutResult) -> DrainResult {
        match result {
            ShellStdoutResult::Drained(drained) => drained,
            ShellStdoutResult::Error { error } => panic!("{error}"),
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn round_trips_stdin_to_stdout_via_cat() {
        reset_process_manager_for_tests();
        let (_guard, ws) = workspace();
        let id = spawn("cat", &ws).await;

        let written = run_shell_stdin(ShellStdinInput {
            process_id: id.clone(),
            data: "hello\n".to_string(),
        })
        .await;
        assert_eq!(written, ShellStdinResult::Ok { ok: true });

        // cat echoes input; wait for it to land in the buffer.
        wait_for(
            || manager().peek(&id, |s| s.stdout.len()).unwrap_or(0) > 0,
            2000,
        )
        .await;

        let result = drained(drain(&id, false).await);
        assert_eq!(result.stdout, "hello\n");
        assert!(result.running);
        kill(&id, None).await;
        reset_process_manager_for_tests();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn captures_the_exit_code_after_the_process_exits() {
        reset_process_manager_for_tests();
        let (_guard, ws) = workspace();
        let id = spawn("sh -c \"echo done; exit 7\"", &ws).await;
        wait_for(
            || {
                manager()
                    .peek(&id, |s| s.exit_code.is_some())
                    .unwrap_or(false)
            },
            2000,
        )
        .await;
        // The output can land just after the exit.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let result = drained(drain(&id, false).await);
        assert_eq!(result.stdout.trim(), "done");
        assert!(!result.running);
        assert_eq!(result.exit_code, Some(7));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn drains_stderr_separately_when_drain_stderr_is_true() {
        reset_process_manager_for_tests();
        let (_guard, ws) = workspace();
        let id = spawn("sh -c \"echo out; echo err >&2\"", &ws).await;
        wait_for(
            || {
                manager()
                    .peek(&id, |s| s.exit_code == Some(0))
                    .unwrap_or(false)
            },
            2000,
        )
        .await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        let out = drained(drain(&id, false).await);
        assert_eq!(out.stdout.trim(), "out");
        assert_eq!(out.stderr, "");

        let err = drained(drain(&id, true).await);
        assert_eq!(err.stderr.trim(), "err");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn sigkill_terminates_a_running_process_and_drops_it_from_the_running_count() {
        reset_process_manager_for_tests();
        let (_guard, ws) = workspace();
        let id = spawn("sleep 30", &ws).await;
        assert_eq!(manager().running_count(), 1);
        assert_eq!(
            kill(&id, Some(KillSignal::Sigkill)).await,
            ShellKillResult { ok: true }
        );
        wait_for(|| manager().running_count() == 0, 3000).await;
        assert_eq!(
            manager().peek(&id, |s| s.signal),
            Some(Some(Signal::SIGKILL))
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reaps_the_entry_on_the_next_drain_after_exit() {
        reset_process_manager_for_tests();
        let (_guard, ws) = workspace();
        let id = spawn("sleep 30", &ws).await;
        kill(&id, Some(KillSignal::Sigkill)).await;
        wait_for(|| manager().peek(&id, |s| s.exited).unwrap_or(false), 3000).await;
        // First drain after exit: returns final state then reaps.
        let first = drained(drain(&id, false).await);
        assert!(!first.running);
        assert_eq!(first.signal.as_deref(), Some("SIGKILL"));
        // Subsequent drain: process is gone.
        assert!(matches!(
            drain(&id, false).await,
            ShellStdoutResult::Error { .. }
        ));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn does_not_reap_on_kill() {
        // Kill leaves the entry in the map, so a process that ignores the signal
        // cannot bypass MAX_PROCESSES; the natural exit handler clears it.
        reset_process_manager_for_tests();
        let (_guard, ws) = workspace();
        let id = spawn("sleep 30", &ws).await;
        assert_eq!(manager().running_count(), 1);
        kill(&id, Some(KillSignal::Sigkill)).await;
        assert!(manager().peek(&id, |_| ()).is_some());
        wait_for(|| manager().running_count() == 0, 3000).await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn returns_ok_false_when_killing_an_unknown_process_id() {
        assert_eq!(kill("nope", None).await, ShellKillResult { ok: false });
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn errors_on_stdin_to_an_unknown_process() {
        let result = run_shell_stdin(ShellStdinInput {
            process_id: "nope".to_string(),
            data: "x".to_string(),
        })
        .await;
        assert_eq!(
            result,
            ShellStdinResult::Error {
                error: "Process nope not found".to_string()
            }
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn caps_each_spawn_within_max_processes() {
        reset_process_manager_for_tests();
        let (_guard, ws) = workspace();
        for _ in 0..MAX_PROCESSES {
            spawn("sleep 30", &ws).await;
        }
        let refused = run_shell_spawn(
            ShellSpawnInput {
                command: "sleep 30".to_string(),
                workdir: None,
            },
            &ws,
        )
        .await
        .unwrap_err();
        assert_eq!(
            refused.to_string(),
            "Too many running processes (10/10). Kill some with shell_kill before spawning more."
        );
        reset_process_manager_for_tests();
    }
}
