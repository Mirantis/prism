//! The processes the agent starts for itself, so a secure takeover can pause them.
//!
//! Every one is started by an execution environment's `run_shell` or `run_program`,
//! and each environment hands the start to `track`. The runtime's own processes —
//! the display, the desktop, the browser, ffmpeg, the container engine's client —
//! are started elsewhere and keep running, since the person typing needs them.
//!
//! SIGSTOP and SIGCONT do the pausing: neither can be caught or ignored, and each
//! process leads its own group, so both reach whatever it forked. A command that
//! starts while the window is open is not started at all until the window closes.
//! In a container each signal is a `docker exec` of its own, so two of them can
//! arrive out of order only for a window shorter than that call, and a person
//! signing in takes far longer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use tokio::sync::broadcast;

use crate::lib::execution_environments::execution_environment::ExecProcess;

/// What [`AgentProcesses::subscribe`] reports, so a caller that times its process
/// can stop the clock while the process is stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentProcessesEvent {
    Suspend,
    Resume,
}

/// Starts a process: the environment's own start, called at once or when the
/// window closes.
pub type ProcessStart = Box<dyn FnOnce() -> Arc<dyn ExecProcess> + Send>;

/// A start held back by the window, run when it closes.
struct Deferred {
    start: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

pub struct AgentProcesses {
    processes: Mutex<Vec<Arc<dyn ExecProcess>>>,
    deferred: Mutex<Vec<Arc<Deferred>>>,
    suspended: AtomicBool,
    exit_hooked: AtomicBool,
    events: broadcast::Sender<AgentProcessesEvent>,
}

impl AgentProcesses {
    pub fn new() -> Self {
        // One `suspend` and one `resume` receiver per running timed command, each
        // dropped when its command ends, so the running commands set the bound.
        let (events, _) = broadcast::channel(64);
        Self {
            processes: Mutex::new(Vec::new()),
            deferred: Mutex::new(Vec::new()),
            suspended: AtomicBool::new(false),
            exit_hooked: AtomicBool::new(false),
            events,
        }
    }

    pub fn is_suspended(&self) -> bool {
        self.suspended.load(Ordering::SeqCst)
    }

    pub fn running(&self) -> usize {
        self.processes.lock().len()
    }

    /// The `suspend` and `resume` events, from now on.
    pub fn subscribe(&self) -> broadcast::Receiver<AgentProcessesEvent> {
        self.events.subscribe()
    }

    /// Start a process on the list. Inside the window the start waits, and the
    /// caller gets a process whose streams and outcome are the real one's once it
    /// runs.
    pub fn track(&self, start: ProcessStart, with_stdin: bool) -> Arc<dyn ExecProcess> {
        if !self.is_suspended() {
            return self.add(start());
        }
        self.defer(start, with_stdin)
    }

    /// Once per window: a command started since the first call already waits.
    /// Sends SIGSTOP to every process on the list, then emits `Suspend`.
    pub fn suspend(&self) {
        todo!()
    }

    /// Sends SIGCONT to every process on the list, runs the held starts, then
    /// emits `Resume`.
    pub fn resume(&self) {
        todo!()
    }

    /// Put a started process on the list until its `ended` settles.
    fn add(&self, process: Arc<dyn ExecProcess>) -> Arc<dyn ExecProcess> {
        todo!()
    }

    /// A stand-in process for a start the window holds: its stdout and stderr
    /// (and stdin when `with_stdin`) are pipes joined to the real process once it
    /// runs, and `ended`/`closed` settle with the real one's. Killing it before
    /// it runs: SIGSTOP and SIGCONT have nothing to act on and report `true`; any
    /// other signal drops the held start, ends both output pipes and settles
    /// `ended` and `closed` with `{ exit_code: None, signal, error: None }`.
    fn defer(&self, start: ProcessStart, with_stdin: bool) -> Arc<dyn ExecProcess> {
        todo!()
    }

    /// Kill every process on the list when the runtime exits. Each leads a group of
    /// its own, so it outlives the runtime otherwise, and one stopped by a takeover
    /// would stay stopped for good. SIGKILL reaches a stopped process. Hooked once,
    /// on the first `add`.
    fn hook_exit(&self) {
        todo!()
    }
}

impl Default for AgentProcesses {
    fn default() -> Self {
        Self::new()
    }
}

pub static AGENT_PROCESSES: LazyLock<AgentProcesses> = LazyLock::new(AgentProcesses::new);
