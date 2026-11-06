//! Process manager for the generic `shell_spawn` family.
//!
//! In-process map of background processes the execution environment started;
//! the agent uses this to start long-running tasks (e.g. `npm run test`), feed
//! them stdin, drain their stdout/stderr, and kill them.
//!
//! Port of the relevant bits of the upstream Lens Agents shell sandbox's
//! process handlers, minus the cross-process MCP plumbing — the runtime
//! calls these directly from its tools.
//!
//! Concurrency cap is intentionally generous (10) because these are
//! agent-driven background tasks; the cap exists to prevent runaway
//! fork-bomb scenarios, not to gate user concurrency.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use indexmap::IndexMap;
use nix::sys::signal::Signal;
use parking_lot::Mutex;
use serde::Serialize;

use crate::lib::execution_environments::execution_environment::{ExecProcess, ExecStdin};

pub const MAX_PROCESSES: usize = 10;
/// 10 MiB per stream.
pub const MAX_OUTPUT_BUFFER: usize = 10 * 1024 * 1024;

/// One background process and what it has printed since the last drain.
pub struct ProcessState {
    pub proc: Arc<dyn ExecProcess>,
    /// Taken from the process at spawn; `None` once it is closed.
    pub stdin: Arc<tokio::sync::Mutex<Option<ExecStdin>>>,
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
        todo!()
    }

    /// Write data to the process's stdin. Fails if the process is not running
    /// or its stdin has been closed (`Process <id> not found`,
    /// `Process <id> has already exited`, `Process <id> stdin is not writable`,
    /// `Process <id> stdin write failed: <reason>`).
    pub async fn stdin(&self, process_id: &str, data: &str) -> anyhow::Result<()> {
        todo!()
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
        todo!()
    }

    /// Send a signal (SIGTERM by default) to the process group, so the shell
    /// wrapper's children get it too.
    pub fn kill(&self, process_id: &str, signal: Option<Signal>) -> bool {
        todo!()
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
        todo!()
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
