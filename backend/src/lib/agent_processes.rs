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

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, watch};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_util::io::StreamReader;

use crate::lib::execution_environments::execution_environment::{
    ExecEnd, ExecOutput, ExecProcess, ExecStdin, ProcessMark, Signal,
};

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

/// The list and the window, changed together so a start and a suspend never
/// interleave.
struct State {
    processes: Vec<Arc<dyn ExecProcess>>,
    /// Starts held back by the window, run when it closes.
    deferred: Vec<Arc<DeferredProcess>>,
    suspended: bool,
}

pub struct AgentProcesses {
    state: Arc<Mutex<State>>,
    exit_hooked: AtomicBool,
    events: broadcast::Sender<AgentProcessesEvent>,
}

impl AgentProcesses {
    pub fn new() -> Self {
        // One receiver per running timed command, each dropped when its command
        // ends, so the running commands set the bound.
        let (events, _) = broadcast::channel(64);
        Self {
            state: Arc::new(Mutex::new(State {
                processes: Vec::new(),
                deferred: Vec::new(),
                suspended: false,
            })),
            exit_hooked: AtomicBool::new(false),
            events,
        }
    }

    pub fn is_suspended(&self) -> bool {
        self.state.lock().suspended
    }

    pub fn running(&self) -> usize {
        self.state.lock().processes.len()
    }

    /// The `suspend` and `resume` events, from now on.
    pub fn subscribe(&self) -> broadcast::Receiver<AgentProcessesEvent> {
        self.events.subscribe()
    }

    /// Start a process on the list. Inside the window the start waits, and the
    /// caller gets a process whose streams and outcome are the real one's once it
    /// runs.
    pub fn track(&self, start: ProcessStart, with_stdin: bool) -> Arc<dyn ExecProcess> {
        let mut state = self.state.lock();
        if !state.suspended {
            let process = start();
            self.add(&mut state, process.clone());
            return process;
        }
        let held = DeferredProcess::new(start, with_stdin);
        state.deferred.push(held.clone());
        held
    }

    /// Once per window: a command started since the first call already waits.
    /// Sends SIGSTOP to every process on the list, then emits `Suspend`.
    pub fn suspend(&self) {
        {
            let mut state = self.state.lock();
            if state.suspended {
                return;
            }
            state.suspended = true;
            for process in &state.processes {
                process.kill(Signal::SIGSTOP);
            }
        }
        let _ = self.events.send(AgentProcessesEvent::Suspend);
    }

    /// Sends SIGCONT to every process on the list, runs the held starts, then
    /// emits `Resume`.
    pub fn resume(&self) {
        {
            let mut state = self.state.lock();
            state.suspended = false;
            for process in &state.processes {
                process.kill(Signal::SIGCONT);
            }
            for held in std::mem::take(&mut state.deferred) {
                if let Some(real) = held.begin() {
                    self.add(&mut state, real.clone());
                    held.link(real);
                }
            }
        }
        let _ = self.events.send(AgentProcessesEvent::Resume);
    }

    /// Put a started process on the list until its `ended` settles.
    fn add(&self, state: &mut State, process: Arc<dyn ExecProcess>) {
        self.hook_exit();
        state.processes.push(process.clone());
        let shared = self.state.clone();
        tokio::spawn(async move {
            process.ended().await;
            shared
                .lock()
                .processes
                .retain(|listed| !same_process(listed, &process));
        });
    }

    /// Kill every process on the list when the runtime exits. Each leads a group of
    /// its own, so it outlives the runtime otherwise, and one stopped by a takeover
    /// would stay stopped for good. SIGKILL reaches a stopped process. Hooked once,
    /// on the first `add`.
    fn hook_exit(&self) {
        if self.exit_hooked.swap(true, Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        // SAFETY: `atexit` registers a plain function; it runs once, in `exit`.
        unsafe {
            libc::atexit(kill_agent_processes_at_exit);
        }
    }

    /// Signal every process on the list. Gives up when the list stays locked,
    /// since the caller is a process on its way out.
    fn signal_all(&self, signal: Signal) {
        let Some(state) = self.state.try_lock_for(Duration::from_millis(100)) else {
            return;
        };
        let processes = state.processes.clone();
        drop(state);
        for process in processes {
            process.kill(signal);
        }
    }

    #[cfg(test)]
    pub(crate) fn holds(&self, process: &Arc<dyn ExecProcess>) -> bool {
        self.state
            .lock()
            .processes
            .iter()
            .any(|listed| same_process(listed, process))
    }
}

impl Default for AgentProcesses {
    fn default() -> Self {
        Self::new()
    }
}

pub static AGENT_PROCESSES: LazyLock<AgentProcesses> = LazyLock::new(AgentProcesses::new);

#[cfg(unix)]
extern "C" fn kill_agent_processes_at_exit() {
    AGENT_PROCESSES.signal_all(Signal::SIGKILL);
}

fn same_process(a: &Arc<dyn ExecProcess>, b: &Arc<dyn ExecProcess>) -> bool {
    std::ptr::addr_eq(Arc::as_ptr(a), Arc::as_ptr(b))
}

/// A stand-in process for a start the window holds: its stdout and stderr (and
/// stdin when asked for) are pipes joined to the real process once it runs, and
/// `ended`/`closed` settle with the real one's. Killing it before it runs:
/// SIGSTOP and SIGCONT have nothing to act on and report `true`; any other
/// signal drops the held start, ends both output pipes and settles `ended` and
/// `closed` with `{ exit_code: None, signal, error: None }`.
struct DeferredProcess {
    inner: Mutex<DeferredInner>,
    stdin: Mutex<Option<ExecStdin>>,
    stdout: Mutex<Option<ExecOutput>>,
    stderr: Mutex<Option<ExecOutput>>,
    ended_tx: watch::Sender<Option<ExecEnd>>,
    closed_tx: watch::Sender<Option<ExecEnd>>,
}

struct DeferredInner {
    start: Option<ProcessStart>,
    real: Option<Arc<dyn ExecProcess>>,
    /// The ends of the stand-in's pipes, joined to the real process's streams.
    stdin_rx: Option<mpsc::UnboundedReceiver<Bytes>>,
    stdout_tx: Option<mpsc::UnboundedSender<io::Result<Bytes>>>,
    stderr_tx: Option<mpsc::UnboundedSender<io::Result<Bytes>>>,
}

impl DeferredProcess {
    fn new(start: ProcessStart, with_stdin: bool) -> Arc<Self> {
        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel();
        let (stderr_tx, stderr_rx) = mpsc::unbounded_channel();
        let (stdin, stdin_rx) = if with_stdin {
            let (tx, rx) = mpsc::unbounded_channel();
            (
                Some(Box::pin(ChannelWriter { tx: Some(tx) }) as ExecStdin),
                Some(rx),
            )
        } else {
            (None, None)
        };
        Arc::new(DeferredProcess {
            inner: Mutex::new(DeferredInner {
                start: Some(start),
                real: None,
                stdin_rx,
                stdout_tx: Some(stdout_tx),
                stderr_tx: Some(stderr_tx),
            }),
            stdin: Mutex::new(stdin),
            stdout: Mutex::new(Some(channel_reader(stdout_rx))),
            stderr: Mutex::new(Some(channel_reader(stderr_rx))),
            ended_tx: watch::channel(None).0,
            closed_tx: watch::channel(None).0,
        })
    }

    /// Run the held start, unless a kill dropped it first.
    fn begin(&self) -> Option<Arc<dyn ExecProcess>> {
        let mut inner = self.inner.lock();
        let start = inner.start.take()?;
        let real = start();
        inner.real = Some(real.clone());
        Some(real)
    }

    /// Join the stand-in's pipes and ends to the process that now runs.
    fn link(self: &Arc<Self>, real: Arc<dyn ExecProcess>) {
        let (stdin_rx, stdout_tx, stderr_tx) = {
            let mut inner = self.inner.lock();
            (
                inner.stdin_rx.take(),
                inner.stdout_tx.take(),
                inner.stderr_tx.take(),
            )
        };
        if let Some(tx) = stdout_tx {
            pump_output(real.take_stdout(), tx);
        }
        if let Some(tx) = stderr_tx {
            pump_output(real.take_stderr(), tx);
        }
        if let (Some(mut rx), Some(mut writer)) = (stdin_rx, real.take_stdin()) {
            tokio::spawn(async move {
                while let Some(chunk) = rx.recv().await {
                    if writer.write_all(&chunk).await.is_err() {
                        return;
                    }
                }
                let _ = writer.shutdown().await;
            });
        }
        let ends = self.clone();
        tokio::spawn(async move {
            let end = real.ended().await;
            ends.ended_tx.send_replace(Some(end));
            let end = real.closed().await;
            ends.closed_tx.send_replace(Some(end));
        });
    }

    fn real(&self) -> Option<Arc<dyn ExecProcess>> {
        self.inner.lock().real.clone()
    }
}

#[async_trait]
impl ExecProcess for DeferredProcess {
    fn mark(&self) -> Option<ProcessMark> {
        self.real().and_then(|real| real.mark())
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
        self.real().and_then(|real| real.exit_code())
    }

    fn signal(&self) -> Option<Signal> {
        self.real().and_then(|real| real.signal())
    }

    async fn ended(&self) -> ExecEnd {
        settled(self.ended_tx.subscribe()).await
    }

    async fn closed(&self) -> ExecEnd {
        settled(self.closed_tx.subscribe()).await
    }

    fn kill(&self, signal: Signal) -> bool {
        let mut inner = self.inner.lock();
        if let Some(real) = inner.real.clone() {
            drop(inner);
            return real.kill(signal);
        }
        // Nothing has run yet: a pause or a continue has nothing to act on, and
        // any other signal ends a process that never started.
        if signal == Signal::SIGSTOP || signal == Signal::SIGCONT {
            return true;
        }
        inner.start = None;
        inner.stdout_tx = None;
        inner.stderr_tx = None;
        drop(inner);
        let end = ExecEnd {
            exit_code: None,
            signal: Some(signal),
            error: None,
        };
        self.ended_tx
            .send_if_modified(|value| settle_once(value, &end));
        self.closed_tx
            .send_if_modified(|value| settle_once(value, &end));
        true
    }
}

/// A promise settles once: a later settle leaves the first value.
fn settle_once(value: &mut Option<ExecEnd>, end: &ExecEnd) -> bool {
    if value.is_some() {
        return false;
    }
    *value = Some(end.clone());
    true
}

async fn settled(mut end: watch::Receiver<Option<ExecEnd>>) -> ExecEnd {
    if let Ok(value) = end.wait_for(Option::is_some).await {
        return value.clone().unwrap_or_default();
    }
    end.borrow().clone().unwrap_or_default()
}

/// Copy a real process's output into the stand-in's pipe, ending the pipe when
/// the output ends.
fn pump_output(source: Option<ExecOutput>, tx: mpsc::UnboundedSender<io::Result<Bytes>>) {
    let Some(mut source) = source else {
        return;
    };
    tokio::spawn(async move {
        let mut chunk = vec![0u8; 16 * 1024];
        loop {
            match source.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    if tx.send(Ok(Bytes::copy_from_slice(&chunk[..n]))).is_err() {
                        // The reader is gone; keep draining so the process never blocks.
                        continue;
                    }
                }
            }
        }
    });
}

fn channel_reader(rx: mpsc::UnboundedReceiver<io::Result<Bytes>>) -> ExecOutput {
    Box::pin(StreamReader::new(UnboundedReceiverStream::new(rx)))
}

/// The stand-in's stdin: what the caller writes waits in the channel until the
/// real process runs. Shutting it down ends the real process's stdin.
struct ChannelWriter {
    tx: Option<mpsc::UnboundedSender<Bytes>>,
}

impl AsyncWrite for ChannelWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let sent = self
            .tx
            .as_ref()
            .is_some_and(|tx| tx.send(Bytes::copy_from_slice(buf)).is_ok());
        if sent {
            Poll::Ready(Ok(buf.len()))
        } else {
            Poll::Ready(Err(io::Error::from(io::ErrorKind::BrokenPipe)))
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.tx = None;
        Poll::Ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    //! Real processes and real signals: SIGSTOP is the whole point, and nothing
    //! fakes it. Each case holds an instance of its own, so a window opened here
    //! never stops another test's commands.

    use super::*;
    use crate::lib::execution_environments::execution_environment::{RunOptions, StdinMode};
    use crate::lib::execution_environments::local::local_env::local_base_env;
    use crate::lib::execution_environments::local::local_process::run_local_shell;

    fn run(processes: &AgentProcesses, command: &str) -> Arc<dyn ExecProcess> {
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

    /// A command that keeps talking, so silence means it is stopped.
    fn chatty(processes: &AgentProcesses) -> (Arc<dyn ExecProcess>, Arc<Mutex<usize>>) {
        // Ticking rather than spinning, so the loop does not load the machine.
        let proc = run(processes, "while true; do echo tick; sleep 0.05; done");
        let ticks = Arc::new(Mutex::new(0usize));
        let mut stdout = proc.take_stdout().unwrap();
        let counter = ticks.clone();
        tokio::spawn(async move {
            let mut chunk = [0u8; 1024];
            while let Ok(n) = stdout.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&chunk[..n]).into_owned();
                *counter.lock() += text.matches("tick").count();
            }
        });
        (proc, ticks)
    }

    async fn poll_until(check: impl Fn() -> bool) -> bool {
        for _ in 0..500 {
            if check() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    async fn stop(proc: Arc<dyn ExecProcess>) {
        proc.kill(Signal::SIGKILL);
        proc.ended().await;
    }

    #[tokio::test]
    async fn forgets_a_process_that_has_exited() {
        let processes = AgentProcesses::new();
        let proc = run(&processes, "exit 0");
        assert!(processes.holds(&proc));
        proc.ended().await;
        assert!(poll_until(|| !processes.holds(&proc)).await);
    }

    #[tokio::test]
    async fn stops_a_running_command_and_starts_it_again() {
        let processes = AgentProcesses::new();
        let (proc, ticks) = chatty(&processes);
        assert!(poll_until(|| *ticks.lock() > 0).await);

        processes.suspend();
        // Ticks already in the pipe are still read after the stop, so wait for the count to settle.
        let mut while_stopped = *ticks.lock();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let now = *ticks.lock();
            if now == while_stopped {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the ticks never settled"
            );
            while_stopped = now;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(*ticks.lock(), while_stopped);

        processes.resume();
        assert!(poll_until(|| *ticks.lock() > while_stopped).await);
        stop(proc).await;
    }

    #[tokio::test]
    async fn holds_a_command_that_lands_inside_the_window_until_it_closes() {
        let processes = AgentProcesses::new();
        processes.suspend();
        let (proc, ticks) = chatty(&processes);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(*ticks.lock(), 0);

        processes.resume();
        assert!(poll_until(|| *ticks.lock() > 0).await);
        stop(proc).await;
    }

    #[tokio::test]
    async fn starts_one_that_lands_in_the_last_moment_of_the_window() {
        let processes = AgentProcesses::new();
        processes.suspend();
        let (proc, ticks) = chatty(&processes);
        processes.resume();
        assert!(poll_until(|| *ticks.lock() > 0).await);
        stop(proc).await;
    }

    #[tokio::test]
    async fn ends_a_held_command_that_is_killed_before_the_window_closes() {
        let processes = AgentProcesses::new();
        processes.suspend();
        let proc = run(&processes, "echo ran");
        let mut stdout = proc.take_stdout().unwrap();

        assert!(proc.kill(Signal::SIGTERM));
        let end = proc.closed().await;
        assert_eq!(end.signal, Some(Signal::SIGTERM));
        processes.resume();
        tokio::time::sleep(Duration::from_millis(100)).await;
        // It never started, so nothing ran when the window closed.
        let mut output = String::new();
        stdout.read_to_string(&mut output).await.unwrap();
        assert_eq!(output, "");
    }

    #[tokio::test]
    async fn kills_what_it_started_stopped_or_not() {
        let processes = AgentProcesses::new();
        let proc = run(&processes, "exec sleep 30");
        processes.suspend();
        processes.signal_all(Signal::SIGKILL);
        let end = proc.ended().await;
        assert_eq!(end.signal, Some(Signal::SIGKILL));
        processes.resume();
    }
}
