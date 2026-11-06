//! A command inside the exec container.
//!
//! Each one is a `docker exec` whose client is an ordinary child of this
//! process, so the streams, the exit code and the launch-failure path are the
//! local implementation's — only the argv differs.
//!
//! Signalling is the part that is not free. Killing the `docker exec` client
//! leaves the process it started running inside the container, so the signal
//! is delivered by a second `docker exec`, which has to find the right process
//! once it is in there. The wrapper records its own id into a file in the
//! container before it starts the command, and the kill reads that file on the
//! same side. `setsid` is what makes one signal reach every grandchild: the
//! wrapper becomes a session leader, so `$$` is the process-group id — the
//! guarantee a local command's own process group gives.
//!
//! The id has to be written down rather than looked up, because `exec`
//! replaces the command line: a name given to the wrapper is gone the moment
//! the command starts, while the pid it already wrote is still the group's.

use std::sync::Arc;

use async_trait::async_trait;
use nix::sys::signal::Signal;

use crate::lib::execution_environments::execution_environment::{
    ExecEnd, ExecOutput, ExecProcess, ExecStdin, ProcessMark, RunOptions,
};

/// How long the signalling `docker exec` gets before it is abandoned.
pub const KILL_TIMEOUT_MS: u64 = 10_000;

/// `$1` is where to write the group id; everything after it is the program and
/// its arguments. Passing them positionally rather than interpolating means no
/// command text is ever quoted into a shell string.
pub const RECORD_PGID: &str = "echo $$ > \"$1\"; shift; exec \"$@\"";

/// Read the group id the wrapper recorded and signal the whole group.
///
/// `$1` is the file, `$2` the signal name. The leader's pid is the group id, so
/// the negative pid reaches every descendant. Exit 1 when the file holds
/// nothing, which is a command that has already ended or has yet to start.
pub const SIGNAL_GROUP: &str =
    "p=$(cat \"$1\" 2>/dev/null); [ -n \"$p\" ] || exit 1; kill -\"$2\" -\"$p\"";

/// Enough of stderr to hold the engine's own error, which comes first.
pub const ENGINE_ERROR_BYTES: usize = 1024;

/// Where a command records its group id, inside the container.
///
/// Nothing outside reads it, so it needs no volume — and nothing removes it
/// either: the file is a handful of bytes and the container is rebuilt on every
/// restart, which is cheaper than a second `docker exec` per command to tidy up.
pub fn pid_file_for(id: &str) -> String {
    format!("/tmp/prism-exec-{id}.pid")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockerExecContext {
    pub container: String,
}

/// `bash -c <command>` is the payload, so a shell command behaves exactly as
/// it does locally, where `run_shell` execs /bin/bash -c too.
pub fn run_docker_shell(
    command: &str,
    options: RunOptions,
    ctx: &DockerExecContext,
) -> Arc<dyn ExecProcess> {
    exec(
        vec!["bash".to_string(), "-c".to_string(), command.to_string()],
        options,
        ctx,
    )
}

pub fn run_docker_program(
    command: &str,
    args: &[String],
    options: RunOptions,
    ctx: &DockerExecContext,
) -> Arc<dyn ExecProcess> {
    let mut payload = Vec::with_capacity(args.len() + 1);
    payload.push(command.to_string());
    payload.extend(args.iter().cloned());
    exec(payload, options, ctx)
}

/// `docker exec [-i] -w <cwd> -e NAME… <container> setsid --wait bash -c
/// RECORD_PGID prism-exec <pid file> <payload…>`, its client a local program
/// started in this process's cwd with `{ …this process's env, …options.env }`,
/// so `-e NAME` without a value takes each value from the client's environment
/// and no credential appears in an argv. `--wait` is relied on: under
/// `docker exec` the entered process is already a process-group leader, so
/// `setsid` forks instead of exec'ing, and without it the client returns the
/// moment the child starts.
fn exec(
    payload: Vec<String>,
    options: RunOptions,
    ctx: &DockerExecContext,
) -> Arc<dyn ExecProcess> {
    todo!()
}

/// A command in the container: the engine client's streams and end, and a kill
/// that reaches the payload's process group.
pub struct DockerProcess {
    pub(crate) client: Arc<dyn ExecProcess>,
    pub(crate) container: String,
    pub(crate) pid_file: String,
}

#[async_trait]
impl ExecProcess for DockerProcess {
    /// A container's processes end with the container, so none is marked.
    fn mark(&self) -> Option<ProcessMark> {
        None
    }

    fn take_stdin(&self) -> Option<ExecStdin> {
        self.client.take_stdin()
    }

    fn take_stdout(&self) -> Option<ExecOutput> {
        self.client.take_stdout()
    }

    /// The client's stderr, read by `watch_for_lost_container` on its way to
    /// the caller.
    fn take_stderr(&self) -> Option<ExecOutput> {
        todo!()
    }

    fn exit_code(&self) -> Option<i32> {
        self.client.exit_code()
    }

    fn signal(&self) -> Option<Signal> {
        self.client.signal()
    }

    async fn ended(&self) -> ExecEnd {
        self.client.ended().await
    }

    async fn closed(&self) -> ExecEnd {
        self.client.closed().await
    }

    fn kill(&self, signal: Signal) -> bool {
        kill_payload(
            &self.container,
            &self.pid_file,
            signal,
            self.client.as_ref(),
        )
    }
}

/// Warn when the engine answers that the container is gone: the first
/// `ENGINE_ERROR_BYTES` of stderr, read beside the caller, go to
/// `report_if_container_lost` once the client exits non-zero.
fn watch_for_lost_container(client: &Arc<dyn ExecProcess>, container: &str) {
    todo!()
}

/// Signal the command's process group inside the container.
///
/// A terminating signal has to end something the caller is waiting on, and the
/// group kill alone cannot promise that: between the engine starting and the
/// wrapper running, the file holds nothing. `SIGKILL` therefore also kills
/// the engine's client, which settles `ended` and `closed` whatever happened
/// inside. It is left out of the gentler signals so a command still gets to
/// flush its output on `SIGTERM`, and `capture_shell` escalates to `SIGKILL`
/// after its grace period, so the guarantee holds with that delay at worst.
///
/// The signal goes by its POSIX name without `SIG`, which every shell's builtin
/// `kill` accepts.
fn kill_payload(container: &str, pid_file: &str, signal: Signal, client: &dyn ExecProcess) -> bool {
    todo!()
}
