//! The programs the desktop runs: one-shot commands, answered the way Node's `execFile`
//! answers them, and long-lived ones whose owner stops them with a signal.
//!
//! These are the runtime's own processes, not the agent's, so they run as children of
//! this process and outside `agentProcesses`.

use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use indexmap::IndexMap;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, watch};

/// `{ ...process.env, ...extra }`: this process's environment with `extra` over it.
pub(crate) fn process_env(extra: &IndexMap<String, String>) -> IndexMap<String, String> {
    let mut env: IndexMap<String, String> = std::env::vars().collect();
    for (key, value) in extra {
        env.insert(key.clone(), value.clone());
    }
    env
}

/// Node's `maxBuffer` default for `execFile`.
pub(crate) const DEFAULT_MAX_BUFFER: usize = 1024 * 1024;

/// How `exec_file` runs a command.
pub(crate) struct ExecFileOptions<'a> {
    /// The whole environment the command gets.
    pub env: &'a IndexMap<String, String>,
    pub timeout_ms: u64,
    /// The most stdout or stderr may hold before the command is killed.
    pub max_buffer: usize,
}

/// The errno name Node puts in a spawn error, such as `ENOENT`.
fn errno_name(err: &std::io::Error) -> String {
    match err.raw_os_error() {
        Some(2) => "ENOENT".to_string(),
        Some(13) => "EACCES".to_string(),
        Some(8) => "ENOEXEC".to_string(),
        Some(20) => "ENOTDIR".to_string(),
        _ => match err.kind() {
            std::io::ErrorKind::NotFound => "ENOENT".to_string(),
            std::io::ErrorKind::PermissionDenied => "EACCES".to_string(),
            _ => err.to_string(),
        },
    }
}

/// The error a failed spawn reads as: `spawn <file> ENOENT`.
pub(crate) fn spawn_error(file: &str, err: &std::io::Error) -> anyhow::Error {
    anyhow::anyhow!("spawn {file} {}", errno_name(err))
}

/// Read a pipe to its end, failing once it holds more than `limit` bytes.
async fn read_capped<R: AsyncRead + Unpin>(pipe: Option<R>, limit: usize) -> Result<Vec<u8>, ()> {
    let Some(mut pipe) = pipe else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => return Ok(out),
            Ok(n) => {
                out.extend_from_slice(&chunk[..n]);
                if out.len() > limit {
                    return Err(());
                }
            }
        }
    }
}

/// Run `file` with `args` and answer its stdout, as `promisify(execFile)` does.
///
/// Fails with `spawn <file> <errno>` when it cannot start, `stdout maxBuffer length
/// exceeded` when it writes more than `max_buffer`, and `Command failed: <file> <args>`
/// followed by a newline and its stderr when it exits other than with 0, a timeout
/// (SIGTERM) included.
pub(crate) async fn exec_file(
    file: &str,
    args: &[String],
    options: ExecFileOptions<'_>,
) -> anyhow::Result<Vec<u8>> {
    let mut command = Command::new(file);
    command
        .args(args)
        .env_clear()
        .envs(options.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|err| spawn_error(file, &err))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let limit = options.max_buffer;

    let collect = async {
        let (out, err) = tokio::join!(read_capped(stdout, limit), read_capped(stderr, limit));
        (out, err)
    };
    let timeout = Duration::from_millis(options.timeout_ms);
    let outcome = tokio::time::timeout(timeout, collect).await;
    let (stdout, stderr) = match outcome {
        Err(_) => {
            terminate(&mut child);
            let _ = child.wait().await;
            return Err(command_failed(file, args, b""));
        }
        Ok((Err(()), _)) => {
            terminate(&mut child);
            let _ = child.wait().await;
            anyhow::bail!("stdout maxBuffer length exceeded");
        }
        Ok((_, Err(()))) => {
            terminate(&mut child);
            let _ = child.wait().await;
            anyhow::bail!("stderr maxBuffer length exceeded");
        }
        Ok((Ok(stdout), Ok(stderr))) => (stdout, stderr),
    };
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(status) => status?,
        Err(_) => {
            terminate(&mut child);
            let _ = child.wait().await;
            return Err(command_failed(file, args, &stderr));
        }
    };
    if !status.success() {
        return Err(command_failed(file, args, &stderr));
    }
    Ok(stdout)
}

fn command_failed(file: &str, args: &[String], stderr: &[u8]) -> anyhow::Error {
    let mut cmd = file.to_string();
    if !args.is_empty() {
        cmd.push(' ');
        cmd.push_str(&args.join(" "));
    }
    anyhow::anyhow!("Command failed: {cmd}\n{}", String::from_utf8_lossy(stderr))
}

/// SIGTERM to a child this task owns, or the platform's kill where there is no signal.
fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGTERM,
            );
            return;
        }
    }
    let _ = child.start_kill();
}

/// A signal to stop a long-lived child with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StopSignal {
    Term,
    Kill,
}

/// How a child ended: its exit code, or the signal that ended it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChildExit {
    pub code: Option<i32>,
    /// The signal's name, such as `SIGTERM`.
    pub signal: Option<String>,
}

impl ChildExit {
    fn from_status(status: &ExitStatus) -> ChildExit {
        #[cfg(unix)]
        let signal = {
            use std::os::unix::process::ExitStatusExt;
            status.signal().map(|number| {
                nix::sys::signal::Signal::try_from(number)
                    .map(|signal| signal.as_str().to_string())
                    .unwrap_or_else(|_| number.to_string())
            })
        };
        #[cfg(not(unix))]
        let signal: Option<String> = None;
        ChildExit {
            code: status.code(),
            signal,
        }
    }

    /// `signal ?? code`, as a log line names how a process left.
    pub fn describe(&self) -> String {
        match (&self.signal, self.code) {
            (Some(signal), _) => signal.clone(),
            (None, Some(code)) => code.to_string(),
            (None, None) => "null".to_string(),
        }
    }
}

/// A long-lived child, owned by a task that waits for it to exit. Cloning gives another
/// handle on the same process.
#[derive(Clone)]
pub(crate) struct ChildHandle {
    pid: Option<u32>,
    exited: Arc<AtomicBool>,
    stop: mpsc::UnboundedSender<StopSignal>,
    exit: watch::Receiver<Option<ChildExit>>,
}

/// The pipes a spawned child was given.
pub(crate) struct ChildPipes {
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
}

/// Which of a child's standard streams are piped; the rest are ignored.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Pipes {
    pub stdin: bool,
    pub stdout: bool,
    pub stderr: bool,
}

fn stdio(piped: bool) -> Stdio {
    if piped { Stdio::piped() } else { Stdio::null() }
}

/// Start `file` with `args` and the whole environment `env`, as Node's `spawn` does.
/// Fails with `spawn <file> <errno>` when it cannot start.
pub(crate) fn spawn_child(
    file: &str,
    args: &[String],
    env: &IndexMap<String, String>,
    pipes: Pipes,
) -> anyhow::Result<(ChildHandle, ChildPipes)> {
    let mut command = Command::new(file);
    command
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(stdio(pipes.stdin))
        .stdout(stdio(pipes.stdout))
        .stderr(stdio(pipes.stderr));
    let mut child = command.spawn().map_err(|err| spawn_error(file, &err))?;
    let child_pipes = ChildPipes {
        stdin: child.stdin.take(),
        stdout: child.stdout.take(),
        stderr: child.stderr.take(),
    };
    let pid = child.id();
    let exited = Arc::new(AtomicBool::new(false));
    let (stop_tx, mut stop_rx) = mpsc::unbounded_channel::<StopSignal>();
    let (exit_tx, exit_rx) = watch::channel::<Option<ChildExit>>(None);
    let done = exited.clone();
    tokio::spawn(async move {
        let status = loop {
            tokio::select! {
                status = child.wait() => break status,
                signal = stop_rx.recv() => match signal {
                    Some(StopSignal::Term) => terminate(&mut child),
                    Some(StopSignal::Kill) => {
                        let _ = child.start_kill();
                    }
                    // Every handle is gone; the process runs on until it exits.
                    None => break child.wait().await,
                },
            }
        };
        let exit = match status {
            Ok(status) => ChildExit::from_status(&status),
            Err(_) => ChildExit {
                code: None,
                signal: None,
            },
        };
        done.store(true, Ordering::SeqCst);
        let _ = exit_tx.send(Some(exit));
    });
    Ok((
        ChildHandle {
            pid,
            exited,
            stop: stop_tx,
            exit: exit_rx,
        },
        child_pipes,
    ))
}

impl ChildHandle {
    /// Whether the process has exited, by a code or a signal.
    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Send the process a signal. A process that already exited is left alone.
    pub fn kill(&self, signal: StopSignal) {
        if self.has_exited() {
            return;
        }
        let _ = self.stop.send(signal);
    }

    /// Wait for the process to exit, and answer how it did.
    pub async fn wait(&self) -> ChildExit {
        let mut exit = self.exit.clone();
        loop {
            if let Some(done) = exit.borrow_and_update().clone() {
                return done;
            }
            if exit.changed().await.is_err() {
                return exit.borrow().clone().unwrap_or(ChildExit {
                    code: None,
                    signal: None,
                });
            }
        }
    }

    /// Whether two handles are on the same process.
    pub fn same(&self, other: &ChildHandle) -> bool {
        Arc::ptr_eq(&self.exited, &other.exited)
    }
}

/// Forward each chunk of a stream to `on_chunk` until it ends.
pub(crate) fn on_chunks<R>(pipe: Option<R>, on_chunk: impl Fn(&[u8]) + Send + 'static)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let Some(mut pipe) = pipe else {
        return;
    };
    tokio::spawn(async move {
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            match pipe.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(n) => on_chunk(&chunk[..n]),
            }
        }
    });
}

/// Send a process a signal by its id, as `process.kill(pid, 'SIGTERM')` does. Fails when
/// there is no such process.
pub(crate) fn kill_pid(pid: i32) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid),
            nix::sys::signal::Signal::SIGTERM,
        )?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        anyhow::bail!("kill ESRCH")
    }
}
