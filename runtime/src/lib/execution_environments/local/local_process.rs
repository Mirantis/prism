//! Processes for the local environment: a child of this server process.
//!
//! `ended` and `closed` are separate because the two callers need different
//! moments. Exit accounting reads `ended`, since a grandchild that inherited
//! the pipes can hold them open long after the process is gone; a caller that
//! builds a result out of the output reads `closed`.

use std::io;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::task::{Context, Poll};

use async_trait::async_trait;
use parking_lot::Mutex;
use tokio::io::{AsyncRead, ReadBuf};
use tokio::sync::{oneshot, watch};

use super::local_files::errno_text;
use crate::lib::execution_environments::execution_environment::{
    ExecEnd, ExecOutput, ExecProcess, ExecStdin, ProcessMark, RunOptions, Signal, StdinMode,
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
///
/// A process group of its own is a new session, as Node's `detached` spawn
/// makes it, so the command has no controlling terminal either.
pub fn run_local_program(
    command: &str,
    args: &[String],
    options: RunOptions,
    process_group: bool,
) -> Arc<dyn ExecProcess> {
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args)
        .current_dir(&options.cwd)
        .env_clear()
        .envs(&options.env)
        .stdin(match options.stdin {
            StdinMode::Ignore => Stdio::null(),
            StdinMode::Pipe => Stdio::piped(),
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    if process_group {
        // SAFETY: `setsid` is async-signal-safe and touches no memory of the
        // parent; it is all that runs between `fork` and `exec`.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    match cmd.spawn() {
        Ok(child) => LocalProcess::start(child, process_group),
        Err(err) => LocalProcess::failed(spawn_error(command, err), options.stdin),
    }
}

/// Node's words for a spawn that failed: `spawn <command> <CODE>`.
fn spawn_error(command: &str, err: io::Error) -> anyhow::Error {
    let (code, _) = errno_text(&err);
    anyhow::Error::new(io::Error::new(err.kind(), format!("spawn {command} {code}")))
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
    pub(crate) state: Arc<Mutex<LocalProcessState>>,
    /// Set once the process has exited (or never started).
    pub(crate) ended: watch::Receiver<Option<ExecEnd>>,
    /// Set once it has exited and both output streams reached end of file.
    pub(crate) closed: watch::Receiver<Option<ExecEnd>>,
    /// Asks the waiter to end the process: Windows has no signals to send.
    pub(crate) kill_requests: tokio::sync::mpsc::UnboundedSender<Signal>,
}

impl LocalProcess {
    fn start(mut child: tokio::process::Child, process_group: bool) -> Arc<dyn ExecProcess> {
        let pid = child.id();
        let mark = match (process_group, pid) {
            (true, Some(pid)) => Some(ProcessMark {
                pid: i64::from(pid),
                started_at: crate::support::now_ms(),
            }),
            _ => None,
        };
        let stdin = child
            .stdin
            .take()
            .map(|stdin| Box::pin(stdin) as ExecStdin);
        let (stdout, stdout_done) = watched(child.stdout.take());
        let (stderr, stderr_done) = watched(child.stderr.take());

        let state = Arc::new(Mutex::new(LocalProcessState::default()));
        let (ended_tx, ended) = watch::channel(None);
        let (closed_tx, closed) = watch::channel(None);
        let (kill_requests, kill_rx) = tokio::sync::mpsc::unbounded_channel();

        tokio::spawn(wait_for_end(
            child,
            state.clone(),
            ended_tx,
            closed_tx,
            [stdout_done, stderr_done],
            kill_rx,
        ));

        Arc::new(LocalProcess {
            pid,
            process_group,
            mark,
            stdin: Mutex::new(stdin),
            stdout: Mutex::new(stdout),
            stderr: Mutex::new(stderr),
            state,
            ended,
            closed,
            kill_requests,
        })
    }

    /// A process that never started: both ends settle at once with the error,
    /// and its streams are empty.
    fn failed(error: anyhow::Error, stdin: StdinMode) -> Arc<dyn ExecProcess> {
        let end = ExecEnd {
            exit_code: None,
            signal: None,
            error: Some(Arc::new(error)),
        };
        let (_, ended) = watch::channel(Some(end.clone()));
        let (_, closed) = watch::channel(Some(end));
        let (kill_requests, _) = tokio::sync::mpsc::unbounded_channel();
        Arc::new(LocalProcess {
            pid: None,
            process_group: false,
            mark: None,
            stdin: Mutex::new(match stdin {
                StdinMode::Pipe => Some(Box::pin(tokio::io::sink()) as ExecStdin),
                StdinMode::Ignore => None,
            }),
            stdout: Mutex::new(Some(Box::pin(tokio::io::empty()) as ExecOutput)),
            stderr: Mutex::new(Some(Box::pin(tokio::io::empty()) as ExecOutput)),
            state: Arc::new(Mutex::new(LocalProcessState::default())),
            ended,
            closed,
            kill_requests,
        })
    }

    fn has_exited(&self) -> bool {
        let state = self.state.lock();
        state.exit_code.is_some() || state.signal.is_some()
    }
}

/// An output stream that reports when it is done: at end of file, on an error,
/// or when its reader is dropped. `closed` waits for both of a process's.
fn watched<R: AsyncRead + Send + Unpin + 'static>(
    stream: Option<R>,
) -> (Option<ExecOutput>, oneshot::Receiver<()>) {
    let (done, finished) = oneshot::channel();
    let output = stream.map(|inner| {
        Box::pin(EofReader {
            inner,
            done: Some(done),
        }) as ExecOutput
    });
    (output, finished)
}

struct EofReader<R> {
    inner: R,
    done: Option<oneshot::Sender<()>>,
}

impl<R: AsyncRead + Unpin> AsyncRead for EofReader<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let room = buf.remaining();
        let poll = Pin::new(&mut this.inner).poll_read(cx, buf);
        if let Poll::Ready(result) = &poll {
            let finished = match result {
                Ok(()) => room > 0 && buf.filled().len() == before,
                Err(_) => true,
            };
            if finished && let Some(done) = this.done.take() {
                let _ = done.send(());
            }
        }
        poll
    }
}

/// Wait for the process to exit (`ended`), then for its output streams to
/// finish (`closed`).
async fn wait_for_end(
    mut child: tokio::process::Child,
    state: Arc<Mutex<LocalProcessState>>,
    ended_tx: watch::Sender<Option<ExecEnd>>,
    closed_tx: watch::Sender<Option<ExecEnd>>,
    streams: [oneshot::Receiver<()>; 2],
    kill_rx: tokio::sync::mpsc::UnboundedReceiver<Signal>,
) {
    #[cfg(unix)]
    let status = {
        drop(kill_rx);
        child.wait().await
    };
    #[cfg(not(unix))]
    let (status, killed_with) = {
        let mut kill_rx = kill_rx;
        let mut killed_with = None;
        let status = loop {
            tokio::select! {
                status = child.wait() => break status,
                Some(signal) = kill_rx.recv() => {
                    killed_with = Some(signal);
                    let _ = child.start_kill();
                }
            }
        };
        (status, killed_with)
    };

    let end = match status {
        Ok(status) => {
            let end = ExecEnd {
                exit_code: status.code(),
                signal: signal_of(&status),
                error: None,
            };
            // Node reports a process it ended on Windows by the signal it was asked for.
            #[cfg(not(unix))]
            let end = match killed_with {
                Some(signal) => ExecEnd {
                    exit_code: None,
                    signal: Some(signal),
                    error: None,
                },
                None => end,
            };
            end
        }
        Err(err) => ExecEnd {
            exit_code: None,
            signal: None,
            error: Some(Arc::new(anyhow::Error::new(err))),
        },
    };
    {
        let mut state = state.lock();
        state.exit_code = end.exit_code;
        state.signal = end.signal;
    }
    let _ = ended_tx.send(Some(end.clone()));
    for stream in streams {
        let _ = stream.await;
    }
    let _ = closed_tx.send(Some(end));
}

#[cfg(unix)]
fn signal_of(status: &std::process::ExitStatus) -> Option<Signal> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().and_then(Signal::from_raw)
}

#[cfg(not(unix))]
fn signal_of(_status: &std::process::ExitStatus) -> Option<Signal> {
    None
}

/// The value a settled end holds, waiting for it to settle first.
pub(crate) async fn settled(mut end: watch::Receiver<Option<ExecEnd>>) -> ExecEnd {
    if let Ok(value) = end.wait_for(Option::is_some).await {
        return value.clone().unwrap_or_default();
    }
    end.borrow().clone().unwrap_or_default()
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
        settled(self.ended.clone()).await
    }

    async fn closed(&self) -> ExecEnd {
        settled(self.closed.clone()).await
    }

    fn kill(&self, signal: Signal) -> bool {
        kill_child(self, signal)
    }
}

/// The group first, so any grandchild of the shell wrapper gets the signal too.
/// Falls back to the child alone where a detached spawn established no new
/// process group. The child alone answers `false` once it has exited.
#[cfg(unix)]
fn kill_child(process: &LocalProcess, signal: Signal) -> bool {
    let Some(pid) = process.pid else {
        return false;
    };
    let pid = pid as libc::pid_t;
    // SAFETY: `kill` only sends a signal; a pid that names nothing fails with ESRCH.
    if process.process_group && unsafe { libc::kill(-pid, signal.as_raw()) } == 0 {
        return true;
    }
    if process.has_exited() {
        return false;
    }
    // SAFETY: as above.
    unsafe { libc::kill(pid, signal.as_raw()) == 0 }
}

/// Windows has no signals: a kill ends the process, and any other signal is
/// ignored, as Node's `child.kill()` does there.
#[cfg(not(unix))]
fn kill_child(process: &LocalProcess, signal: Signal) -> bool {
    if process.pid.is_none() || process.has_exited() {
        return false;
    }
    match signal {
        Signal::SIGKILL | Signal::SIGTERM | Signal::SIGINT | Signal::SIGQUIT => {
            process.kill_requests.send(signal).is_ok()
        }
        _ => false,
    }
}
