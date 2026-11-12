//! Fake processes, files and execution environments for the tests of the coding
//! agents and the tools that drive them. Each stands in for one seam the code
//! reads: a process's streams, its end and its signals, and the members of an
//! environment a test states. An unsupplied member fails loudly rather than
//! reaching the real host.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use async_trait::async_trait;
use bytes::Bytes;
use parking_lot::Mutex;
use tokio::io::AsyncWrite;
use tokio::sync::{mpsc, watch};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_util::io::StreamReader;

use crate::lib::execution_environments::execution_environment::{
    AgentPaths, DirEntry, ExecEnd, ExecOutput, ExecProcess, ExecStdin, ExecutionEnvironment,
    ExecutionEnvironmentName, ExecutionFiles, FileStat, PreparedWorkspace, ProcessEnv, ProcessMark,
    RunOptions, Signal,
};
use crate::lib::execution_environments::local::local_files::LocalFiles;

type Sender = mpsc::UnboundedSender<std::io::Result<Bytes>>;

/// One output stream: the test writes to it, the code under test reads it.
struct Pipe {
    writer: Mutex<Option<Sender>>,
    reader: Mutex<Option<ExecOutput>>,
}

impl Pipe {
    fn new() -> Pipe {
        let (tx, rx) = mpsc::unbounded_channel();
        let reader: ExecOutput = Box::pin(StreamReader::new(UnboundedReceiverStream::new(rx)));
        Pipe {
            writer: Mutex::new(Some(tx)),
            reader: Mutex::new(Some(reader)),
        }
    }

    fn write(&self, text: &str) {
        if let Some(tx) = self.writer.lock().as_ref() {
            let _ = tx.send(Ok(Bytes::from(text.to_string())));
        }
    }

    fn end(&self) {
        self.writer.lock().take();
    }
}

/// What the code under test wrote to a process's stdin, and whether it closed it.
#[derive(Default)]
pub struct StdinRecord {
    pub written: Mutex<Vec<u8>>,
    pub closed: std::sync::atomic::AtomicBool,
}

impl StdinRecord {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.written.lock()).into_owned()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(std::sync::atomic::Ordering::SeqCst)
    }
}

struct RecordingStdin(Arc<StdinRecord>);

impl AsyncWrite for RecordingStdin {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        self.0.written.lock().extend_from_slice(buf);
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.0
            .closed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Poll::Ready(Ok(()))
    }
}

impl Drop for RecordingStdin {
    fn drop(&mut self) {
        self.0
            .closed
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// How a fake process answers a signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillBehavior {
    /// Ends with code 143 on any signal.
    Ends,
    /// Ends only on SIGKILL, so an escalation after SIGTERM is observable.
    SigkillOnly,
    /// Ignores every signal and never closes its output.
    Stubborn,
}

struct ChildState {
    finished: bool,
    exit_code: Option<i32>,
    signal: Option<Signal>,
}

/// A process that runs nothing: the test writes its output and decides its end.
pub struct FakeChild {
    stdout: Pipe,
    stderr: Pipe,
    pub stdin: Arc<StdinRecord>,
    stdin_writer: Mutex<Option<ExecStdin>>,
    state: Mutex<ChildState>,
    end: watch::Sender<Option<ExecEnd>>,
    pub signals: Mutex<Vec<Signal>>,
    pub mark: Mutex<Option<ProcessMark>>,
    behavior: KillBehavior,
}

impl FakeChild {
    pub fn new() -> Arc<FakeChild> {
        FakeChild::with(KillBehavior::Ends)
    }

    pub fn with(behavior: KillBehavior) -> Arc<FakeChild> {
        let stdin = Arc::new(StdinRecord::default());
        let writer: ExecStdin = Box::pin(RecordingStdin(stdin.clone()));
        Arc::new(FakeChild {
            stdout: Pipe::new(),
            stderr: Pipe::new(),
            stdin,
            stdin_writer: Mutex::new(Some(writer)),
            state: Mutex::new(ChildState {
                finished: false,
                exit_code: None,
                signal: None,
            }),
            end: watch::channel(None).0,
            signals: Mutex::new(Vec::new()),
            mark: Mutex::new(None),
            behavior,
        })
    }

    /// The process as the environment hands it out.
    pub fn process(self: &Arc<Self>) -> Arc<dyn ExecProcess> {
        self.clone()
    }

    pub fn emit_line(&self, line: &str) {
        self.stdout.write(&format!("{line}\n"));
    }

    pub fn write_stdout(&self, text: &str) {
        self.stdout.write(text);
    }

    pub fn write_stderr(&self, text: &str) {
        self.stderr.write(text);
    }

    pub fn end_streams(&self) {
        self.stdout.end();
        self.stderr.end();
    }

    /// Exit with `code`: the streams end, then the process.
    pub fn finish(&self, code: Option<i32>) {
        let signal = {
            let mut state = self.state.lock();
            if state.finished {
                return;
            }
            state.finished = true;
            state.exit_code = code;
            state.signal
        };
        self.end_streams();
        self.end.send_replace(Some(ExecEnd {
            exit_code: code,
            signal,
            error: None,
        }));
    }

    /// The `exit` event alone, with the streams left as they are.
    pub fn exit(&self, code: Option<i32>, signal: Option<Signal>) {
        {
            let mut state = self.state.lock();
            state.finished = true;
            state.exit_code = code;
            state.signal = signal;
        }
        self.end.send_replace(Some(ExecEnd {
            exit_code: code,
            signal,
            error: None,
        }));
    }

    /// A launch that fails, as the environment reports it: no exit, an error.
    pub fn fail(&self, message: &str) {
        self.end_streams();
        self.state.lock().finished = true;
        self.end.send_replace(Some(ExecEnd {
            exit_code: None,
            signal: None,
            error: Some(Arc::new(anyhow::anyhow!("{message}"))),
        }));
    }

    pub fn signals(&self) -> Vec<Signal> {
        self.signals.lock().clone()
    }
}

#[async_trait]
impl ExecProcess for FakeChild {
    fn mark(&self) -> Option<ProcessMark> {
        *self.mark.lock()
    }

    fn take_stdin(&self) -> Option<ExecStdin> {
        self.stdin_writer.lock().take()
    }

    fn take_stdout(&self) -> Option<ExecOutput> {
        self.stdout.reader.lock().take()
    }

    fn take_stderr(&self) -> Option<ExecOutput> {
        self.stderr.reader.lock().take()
    }

    fn exit_code(&self) -> Option<i32> {
        self.state.lock().exit_code
    }

    fn signal(&self) -> Option<Signal> {
        self.state.lock().signal
    }

    async fn ended(&self) -> ExecEnd {
        let mut rx = self.end.subscribe();
        match rx.wait_for(Option::is_some).await {
            Ok(end) => end.clone().unwrap_or_default(),
            Err(_) => ExecEnd::default(),
        }
    }

    async fn closed(&self) -> ExecEnd {
        self.ended().await
    }

    fn kill(&self, signal: Signal) -> bool {
        self.signals.lock().push(signal);
        match self.behavior {
            KillBehavior::Ends => self.finish(Some(143)),
            KillBehavior::SigkillOnly => {
                if signal == Signal::SIGKILL {
                    self.state.lock().signal = Some(Signal::SIGKILL);
                    self.finish(None);
                }
            }
            KillBehavior::Stubborn => {}
        }
        true
    }
}

type StatFn = Arc<dyn Fn(&str) -> anyhow::Result<FileStat> + Send + Sync>;
type WriteFn = Arc<dyn Fn(&str, &str) -> anyhow::Result<()> + Send + Sync>;
type ReadFn = Arc<dyn Fn(&str) -> anyhow::Result<String> + Send + Sync>;

/// Files that answer what the test states, then the base files when given, and
/// otherwise fail as unsupplied.
#[derive(Clone, Default)]
pub struct FakeFiles {
    pub base: Option<Arc<dyn ExecutionFiles>>,
    pub stat: Option<StatFn>,
    pub write_text: Option<WriteFn>,
    pub read_text: Option<ReadFn>,
    /// Every directory `make_temp_dir` made.
    pub temp_dirs: Arc<Mutex<Vec<String>>>,
}

impl FakeFiles {
    /// Over the real filesystem.
    pub fn local() -> FakeFiles {
        FakeFiles {
            base: Some(Arc::new(LocalFiles)),
            ..Default::default()
        }
    }

    fn base(&self, member: &str) -> anyhow::Result<&Arc<dyn ExecutionFiles>> {
        self.base.as_ref().ok_or_else(|| {
            anyhow::anyhow!("fake execution environment: files.{member} was not supplied")
        })
    }
}

/// A directory, as a stat that succeeds reports it.
pub const DIR_STAT: FileStat = FileStat {
    size: 0,
    mtime_ms: 0.0,
    is_file: false,
    is_directory: true,
    is_symbolic_link: false,
};

#[async_trait]
impl ExecutionFiles for FakeFiles {
    async fn read_text(&self, path: &str, max_bytes: Option<usize>) -> anyhow::Result<String> {
        if let Some(read) = &self.read_text {
            return read(path);
        }
        self.base("readText")?.read_text(path, max_bytes).await
    }

    async fn read_bytes(&self, path: &str) -> anyhow::Result<Vec<u8>> {
        self.base("readBytes")?.read_bytes(path).await
    }

    async fn write_text(&self, path: &str, content: &str, mode: Option<u32>) -> anyhow::Result<()> {
        if let Some(write) = &self.write_text {
            return write(path, content);
        }
        self.base("writeText")?
            .write_text(path, content, mode)
            .await
    }

    async fn write_bytes(&self, path: &str, content: &[u8]) -> anyhow::Result<()> {
        self.base("writeBytes")?.write_bytes(path, content).await
    }

    async fn mkdir(&self, path: &str) -> anyhow::Result<()> {
        self.base("mkdir")?.mkdir(path).await
    }

    async fn make_temp_dir(&self, prefix: &str) -> anyhow::Result<String> {
        let dir = self.base("makeTempDir")?.make_temp_dir(prefix).await?;
        self.temp_dirs.lock().push(dir.clone());
        Ok(dir)
    }

    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        self.base("rename")?.rename(from, to).await
    }

    async fn stat(&self, path: &str) -> anyhow::Result<FileStat> {
        if let Some(stat) = &self.stat {
            return stat(path);
        }
        self.base("stat")?.stat(path).await
    }

    async fn lstat(&self, path: &str) -> anyhow::Result<FileStat> {
        self.base("lstat")?.lstat(path).await
    }

    async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<DirEntry>> {
        self.base("readDir")?.read_dir(path).await
    }

    async fn remove(&self, path: &str) -> anyhow::Result<()> {
        self.base("remove")?.remove(path).await
    }

    async fn remove_dir(&self, path: &str) -> anyhow::Result<()> {
        self.base("removeDir")?.remove_dir(path).await
    }

    async fn symlink(&self, target: &str, link_path: &str) -> anyhow::Result<()> {
        self.base("symlink")?.symlink(target, link_path).await
    }

    async fn realpath(&self, path: &str) -> anyhow::Result<String> {
        self.base("realpath")?.realpath(path).await
    }
}

type RunProgramFn = Arc<dyn Fn(&str, &[String], RunOptions) -> Arc<dyn ExecProcess> + Send + Sync>;

/// An execution environment whose processes are the test's.
#[derive(Clone)]
pub struct FakeEnvironment {
    pub workspace_root: String,
    pub paths: AgentPaths,
    pub base_env: ProcessEnv,
    pub serves_path: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub run_program: Option<RunProgramFn>,
    pub files: FakeFiles,
}

/// The agent's directories under a fake root, so a test can assert on them.
pub fn fake_paths(root: &str) -> AgentPaths {
    AgentPaths {
        skills_dir: format!("{root}/skills"),
        plugins_dir: format!("{root}/plugins"),
        plugin_data_dir: format!("{root}/plugin-data"),
        tool_output_dir: format!("{root}/tool-outputs"),
        claude_home: format!("{root}/.claude"),
        codex_home: format!("{root}/.codex"),
    }
}

impl Default for FakeEnvironment {
    fn default() -> Self {
        FakeEnvironment {
            workspace_root: "/workspace".to_string(),
            paths: fake_paths("/workspace"),
            base_env: ProcessEnv::new(),
            serves_path: Arc::new(|_| true),
            run_program: None,
            files: FakeFiles::default(),
        }
    }
}

impl FakeEnvironment {
    pub fn with_run_program(
        run: impl Fn(&str, &[String], RunOptions) -> Arc<dyn ExecProcess> + Send + Sync + 'static,
    ) -> FakeEnvironment {
        FakeEnvironment {
            run_program: Some(Arc::new(run)),
            ..Default::default()
        }
    }

    pub fn arc(self) -> Arc<dyn ExecutionEnvironment> {
        Arc::new(self)
    }
}

#[async_trait]
impl ExecutionEnvironment for FakeEnvironment {
    fn id(&self) -> ExecutionEnvironmentName {
        ExecutionEnvironmentName::Local
    }

    fn display_name(&self) -> String {
        "fake".to_string()
    }

    fn workspace_root(&self) -> String {
        self.workspace_root.clone()
    }

    fn paths(&self) -> AgentPaths {
        self.paths.clone()
    }

    fn prepare_workspace(&self) -> PreparedWorkspace {
        PreparedWorkspace {
            root: self.workspace_root.clone(),
            fell_back_from: None,
        }
    }

    async fn start(&self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn shutdown(&self) {}

    fn serves_path(&self, path: &str) -> bool {
        (self.serves_path)(path)
    }

    fn base_env(&self) -> ProcessEnv {
        self.base_env.clone()
    }

    fn run_shell(&self, _command: &str, _options: RunOptions) -> Arc<dyn ExecProcess> {
        panic!("fake execution environment: runShell was not supplied")
    }

    fn run_program(
        &self,
        command: &str,
        args: &[String],
        options: RunOptions,
    ) -> Arc<dyn ExecProcess> {
        match &self.run_program {
            Some(run) => run(command, args, options),
            None => panic!("fake execution environment: runProgram was not supplied"),
        }
    }

    fn files(&self) -> Arc<dyn ExecutionFiles> {
        Arc::new(self.files.clone())
    }
}

/// An env built from pairs, in order.
pub fn env_of(pairs: &[(&str, &str)]) -> ProcessEnv {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// Waits until `check` holds, for up to a second.
pub async fn wait_for(mut check: impl FnMut() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(check(), "the condition did not hold in time");
}
