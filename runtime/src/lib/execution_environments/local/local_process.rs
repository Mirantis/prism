//! Processes for the local environment: a child of this server process.
//!
//! `ended` and `closed` are separate because the two callers need different
//! moments. Exit accounting reads `ended`, since a grandchild that inherited
//! the pipes can hold them open long after the process is gone; a caller that
//! builds a result out of the output reads `closed`.

use std::sync::Arc;

use async_trait::async_trait;
use nix::sys::signal::Signal;
use parking_lot::Mutex;
use tokio::sync::watch;

use crate::lib::execution_environments::execution_environment::{
    ExecEnd, ExecOutput, ExecProcess, ExecStdin, ProcessMark, RunOptions,
};

pub const SHELL: &str = "/bin/bash";

/// `process_group` makes the child lead its own group, so `kill` signals the whole
/// group rather than leaving a shell wrapper's forked children behind. Every
/// command the agent starts runs that way; the runtime's own calls, such as the
/// container engine's client, stay in the runtime's group.
pub fn run_local_shell(
    command: &str,
    options: RunOptions,
    process_group: bool,
) -> Arc<dyn ExecProcess> {
    run_local_program(
        SHELL,
        &["-c".to_string(), command.to_string()],
        options,
        process_group,
    )
}

/// Spawn `command` with `args`: stdin as `options.stdin` asks, stdout and stderr
/// piped. A spawn failure — a missing binary, a cwd that doesn't exist — is the
/// process's end (`ExecEnd.error`), never a panic or an `Err`.
pub fn run_local_program(
    command: &str,
    args: &[String],
    options: RunOptions,
    process_group: bool,
) -> Arc<dyn ExecProcess> {
    todo!()
}

/// What a running process reports while it runs and once it ends.
#[derive(Debug, Clone, Default)]
pub struct LocalProcessState {
    pub exit_code: Option<i32>,
    pub signal: Option<Signal>,
}

/// A child of this process.
pub struct LocalProcess {
    pub(crate) pid: Option<u32>,
    pub(crate) process_group: bool,
    pub(crate) mark: Option<ProcessMark>,
    pub(crate) stdin: Mutex<Option<ExecStdin>>,
    pub(crate) stdout: Mutex<Option<ExecOutput>>,
    pub(crate) stderr: Mutex<Option<ExecOutput>>,
    pub(crate) state: Mutex<LocalProcessState>,
    /// Set once the process has exited (or never started).
    pub(crate) ended: watch::Receiver<Option<ExecEnd>>,
    /// Set once it has exited and both output streams reached end of file.
    pub(crate) closed: watch::Receiver<Option<ExecEnd>>,
}

#[async_trait]
impl ExecProcess for LocalProcess {
    fn mark(&self) -> Option<ProcessMark> {
        self.mark
    }

    fn take_stdin(&self) -> Option<ExecStdin> {
        self.stdin.lock().take()
    }

    fn take_stdout(&self) -> Option<ExecOutput> {
        self.stdout.lock().take()
    }

    fn take_stderr(&self) -> Option<ExecOutput> {
        self.stderr.lock().take()
    }

    fn exit_code(&self) -> Option<i32> {
        self.state.lock().exit_code
    }

    fn signal(&self) -> Option<Signal> {
        self.state.lock().signal
    }

    async fn ended(&self) -> ExecEnd {
        todo!()
    }

    async fn closed(&self) -> ExecEnd {
        todo!()
    }

    fn kill(&self, signal: Signal) -> bool {
        todo!()
    }
}

/// The group first, so any grandchild of the shell wrapper gets the signal too.
/// Falls back to the child alone where a detached spawn established no new
/// process group.
fn kill_child(pid: Option<u32>, signal: Signal, process_group: bool) -> bool {
    todo!()
}
