//! The execution environment: where a command runs and what filesystem it sees.
//!
//! Every process the agent starts — `shell_exec`, `shell_spawn`, a coding
//! agent's CLI — and every file its tools read or write go through one of
//! these. `get_execution_environment` picks the implementation.
//!
//! A read or write belongs here when the agent's own commands have to see the
//! same bytes. That covers the workspace, the attachment scratch dir, skills,
//! plugins and the saved copies of oversized tool results, since each of those
//! is a path the runtime hands the model and tells it to use the shell on. The
//! database and the runtime's own processes — the updater, the meeting and
//! computer stacks — stay outside.
//!
//! Errors are returned as `Err`: every caller already turns a failed file
//! operation into its own `{ error }` or an empty result. A file error that has
//! an errno meaning (a missing path, a path under a file, a refused permission,
//! a populated directory) is a `std::io::Error` of that kind inside the
//! `anyhow::Error`, so a caller that branches on a missing file downcasts and
//! reads `kind()` in either environment.

use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};

/// A signal by its POSIX name (`NodeJS.Signals`). The type exists on every
/// platform; only Unix delivers one, and on Windows a kill ends the process as
/// Node's `child.kill()` does there.
#[allow(non_camel_case_types, clippy::upper_case_acronyms)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Signal {
    SIGHUP,
    SIGINT,
    SIGQUIT,
    SIGILL,
    SIGTRAP,
    SIGABRT,
    SIGBUS,
    SIGFPE,
    SIGKILL,
    SIGUSR1,
    SIGSEGV,
    SIGUSR2,
    SIGPIPE,
    SIGALRM,
    SIGTERM,
    SIGCHLD,
    SIGCONT,
    SIGSTOP,
    SIGTSTP,
    SIGTTIN,
    SIGTTOU,
    SIGURG,
    SIGXCPU,
    SIGXFSZ,
    SIGVTALRM,
    SIGPROF,
    SIGWINCH,
    SIGIO,
    SIGSYS,
}

impl Signal {
    pub const ALL: [Signal; 29] = [
        Signal::SIGHUP,
        Signal::SIGINT,
        Signal::SIGQUIT,
        Signal::SIGILL,
        Signal::SIGTRAP,
        Signal::SIGABRT,
        Signal::SIGBUS,
        Signal::SIGFPE,
        Signal::SIGKILL,
        Signal::SIGUSR1,
        Signal::SIGSEGV,
        Signal::SIGUSR2,
        Signal::SIGPIPE,
        Signal::SIGALRM,
        Signal::SIGTERM,
        Signal::SIGCHLD,
        Signal::SIGCONT,
        Signal::SIGSTOP,
        Signal::SIGTSTP,
        Signal::SIGTTIN,
        Signal::SIGTTOU,
        Signal::SIGURG,
        Signal::SIGXCPU,
        Signal::SIGXFSZ,
        Signal::SIGVTALRM,
        Signal::SIGPROF,
        Signal::SIGWINCH,
        Signal::SIGIO,
        Signal::SIGSYS,
    ];

    /// The name Node reports (`SIGTERM`).
    pub fn as_str(self) -> &'static str {
        match self {
            Signal::SIGHUP => "SIGHUP",
            Signal::SIGINT => "SIGINT",
            Signal::SIGQUIT => "SIGQUIT",
            Signal::SIGILL => "SIGILL",
            Signal::SIGTRAP => "SIGTRAP",
            Signal::SIGABRT => "SIGABRT",
            Signal::SIGBUS => "SIGBUS",
            Signal::SIGFPE => "SIGFPE",
            Signal::SIGKILL => "SIGKILL",
            Signal::SIGUSR1 => "SIGUSR1",
            Signal::SIGSEGV => "SIGSEGV",
            Signal::SIGUSR2 => "SIGUSR2",
            Signal::SIGPIPE => "SIGPIPE",
            Signal::SIGALRM => "SIGALRM",
            Signal::SIGTERM => "SIGTERM",
            Signal::SIGCHLD => "SIGCHLD",
            Signal::SIGCONT => "SIGCONT",
            Signal::SIGSTOP => "SIGSTOP",
            Signal::SIGTSTP => "SIGTSTP",
            Signal::SIGTTIN => "SIGTTIN",
            Signal::SIGTTOU => "SIGTTOU",
            Signal::SIGURG => "SIGURG",
            Signal::SIGXCPU => "SIGXCPU",
            Signal::SIGXFSZ => "SIGXFSZ",
            Signal::SIGVTALRM => "SIGVTALRM",
            Signal::SIGPROF => "SIGPROF",
            Signal::SIGWINCH => "SIGWINCH",
            Signal::SIGIO => "SIGIO",
            Signal::SIGSYS => "SIGSYS",
        }
    }

    /// The signal a name spells, `None` for any other text.
    pub fn from_name(name: &str) -> Option<Signal> {
        Signal::ALL.into_iter().find(|signal| signal.as_str() == name)
    }

    /// The platform's number for the signal.
    #[cfg(unix)]
    pub fn as_raw(self) -> i32 {
        match self {
            Signal::SIGHUP => libc::SIGHUP,
            Signal::SIGINT => libc::SIGINT,
            Signal::SIGQUIT => libc::SIGQUIT,
            Signal::SIGILL => libc::SIGILL,
            Signal::SIGTRAP => libc::SIGTRAP,
            Signal::SIGABRT => libc::SIGABRT,
            Signal::SIGBUS => libc::SIGBUS,
            Signal::SIGFPE => libc::SIGFPE,
            Signal::SIGKILL => libc::SIGKILL,
            Signal::SIGUSR1 => libc::SIGUSR1,
            Signal::SIGSEGV => libc::SIGSEGV,
            Signal::SIGUSR2 => libc::SIGUSR2,
            Signal::SIGPIPE => libc::SIGPIPE,
            Signal::SIGALRM => libc::SIGALRM,
            Signal::SIGTERM => libc::SIGTERM,
            Signal::SIGCHLD => libc::SIGCHLD,
            Signal::SIGCONT => libc::SIGCONT,
            Signal::SIGSTOP => libc::SIGSTOP,
            Signal::SIGTSTP => libc::SIGTSTP,
            Signal::SIGTTIN => libc::SIGTTIN,
            Signal::SIGTTOU => libc::SIGTTOU,
            Signal::SIGURG => libc::SIGURG,
            Signal::SIGXCPU => libc::SIGXCPU,
            Signal::SIGXFSZ => libc::SIGXFSZ,
            Signal::SIGVTALRM => libc::SIGVTALRM,
            Signal::SIGPROF => libc::SIGPROF,
            Signal::SIGWINCH => libc::SIGWINCH,
            Signal::SIGIO => libc::SIGIO,
            Signal::SIGSYS => libc::SIGSYS,
        }
    }

    /// The signal behind a platform number, `None` for one without a name here.
    #[cfg(unix)]
    pub fn from_raw(raw: i32) -> Option<Signal> {
        Signal::ALL.into_iter().find(|signal| signal.as_raw() == raw)
    }
}

impl std::fmt::Display for Signal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The environment variables a process starts with (`NodeJS.ProcessEnv`), in
/// insertion order.
pub type ProcessEnv = IndexMap<String, String>;

/// A process's stdin, writable once taken.
pub type ExecStdin = Pin<Box<dyn AsyncWrite + Send>>;

/// One of a process's output streams, readable once taken.
pub type ExecOutput = Pin<Box<dyn AsyncRead + Send>>;

/// Why a process never started, shared by every waiter on its end.
pub type ExecError = Arc<anyhow::Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionEnvironmentName {
    Local,
    Docker,
}

impl ExecutionEnvironmentName {
    pub fn as_str(self) -> &'static str {
        match self {
            ExecutionEnvironmentName::Local => "local",
            ExecutionEnvironmentName::Docker => "docker",
        }
    }

    /// The name from its stored or configured text.
    pub fn parse(text: &str) -> Option<ExecutionEnvironmentName> {
        match text {
            "local" => Some(ExecutionEnvironmentName::Local),
            "docker" => Some(ExecutionEnvironmentName::Docker),
            _ => None,
        }
    }
}

impl std::fmt::Display for ExecutionEnvironmentName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What `prepare_workspace` reports: the usable root and, when the intended one
/// could not be used, that root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedWorkspace {
    pub root: String,
    pub fell_back_from: Option<String>,
}

#[async_trait]
pub trait ExecutionEnvironment: Send + Sync {
    fn id(&self) -> ExecutionEnvironmentName;
    /// The name the startup log reports.
    fn display_name(&self) -> String;

    /// Default cwd for a command, and the base a relative path resolves from.
    fn workspace_root(&self) -> String;
    /// Where the agent's own directories are, in this environment's namespace.
    ///
    /// The runtime keeps its data directory to itself — the database and the
    /// media store — while everything the agent works with is the environment's
    /// to place, because an environment whose storage is not this machine's
    /// filesystem has its own names for all of it.
    fn paths(&self) -> AgentPaths;
    /// Boot-time: make that root usable. `fell_back_from` names the root that
    /// could not be used, so the caller can warn; `None` when the intended one
    /// works.
    fn prepare_workspace(&self) -> PreparedWorkspace;
    /// Bring the environment up, once, at boot. Fails when it cannot serve
    /// commands, which the selector turns into a fall back to `local`.
    async fn start(&self) -> anyhow::Result<()>;
    /// Tear it down at shutdown. Never fails: the process is leaving either way.
    async fn shutdown(&self);
    /// Whether a command with this cwd can run here. An environment that sees
    /// only part of the host filesystem answers false for the rest, and the
    /// caller falls back to `local` — see `get_execution_environment_for`.
    fn serves_path(&self, path: &str) -> bool;
    /// The environment a command inherits, with the runtime's own vars removed.
    fn base_env(&self) -> ProcessEnv;

    /// Run `command` through a shell.
    fn run_shell(&self, command: &str, options: RunOptions) -> Arc<dyn ExecProcess>;
    /// Run a program with argv and no shell — a coding agent's CLI, `git`.
    fn run_program(
        &self,
        command: &str,
        args: &[String],
        options: RunOptions,
    ) -> Arc<dyn ExecProcess>;

    fn files(&self) -> Arc<dyn ExecutionFiles>;
}

/// The agent's directories. Every one of them is reached through `files`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPaths {
    pub skills_dir: String,
    pub plugins_dir: String,
    /// A plugin's MCP server keeps its own data under `<plugin_data_dir>/<plugin id>`.
    pub plugin_data_dir: String,
    pub tool_output_dir: String,
    /// `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, which the coding agents are told.
    pub claude_home: String,
    pub codex_home: String,
}

/// Whether the caller writes to the process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StdinMode {
    #[default]
    Ignore,
    /// The caller writes to the process.
    Pipe,
}

#[derive(Debug, Clone)]
pub struct RunOptions {
    pub cwd: String,
    pub env: ProcessEnv,
    /// `Pipe` when the caller writes to the process.
    pub stdin: StdinMode,
}

/// Names a host process to a later boot of the runtime: its pid, and when it
/// started, which tells it apart from a later process given the same pid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMark {
    pub pid: i64,
    /// Epoch milliseconds.
    pub started_at: i64,
}

/// A started process. Held as `Arc<dyn ExecProcess>`: one owner reads its
/// streams while others wait on its end or signal it.
///
/// Each stream is taken once, by the one reader of it; a second `take_*`
/// returns `None`, as does a stream the process was not given.
#[async_trait]
pub trait ExecProcess: Send + Sync {
    /// Set when the process can outlive a runtime that a crash stops: it leads a
    /// process group on this host. A container's processes end with the
    /// container, which the next boot replaces.
    fn mark(&self) -> Option<ProcessMark>;
    fn take_stdin(&self) -> Option<ExecStdin>;
    fn take_stdout(&self) -> Option<ExecOutput>;
    fn take_stderr(&self) -> Option<ExecOutput>;
    /// `None` while the process runs.
    fn exit_code(&self) -> Option<i32>;
    fn signal(&self) -> Option<Signal>;
    /// Settles when the process ends, whether or not its pipes have drained. A
    /// grandchild can inherit those pipes and hold them open long after the
    /// process itself is gone, which is why running/exit accounting reads this
    /// one and not `closed`.
    async fn ended(&self) -> ExecEnd;
    /// Settles once the output streams have closed as well.
    async fn closed(&self) -> ExecEnd;
    /// Signal a running process, reporting whether the signal went out.
    ///
    /// A terminating signal has to reach something that settles `ended` and
    /// `closed`, since every caller kills and then waits on the same process.
    fn kill(&self, signal: Signal) -> bool;
}

#[derive(Debug, Clone, Default)]
pub struct ExecEnd {
    pub exit_code: Option<i32>,
    pub signal: Option<Signal>,
    /// Set when the process never started.
    pub error: Option<ExecError>,
}

/// The files of one environment.
#[async_trait]
pub trait ExecutionFiles: Send + Sync {
    /// `max_bytes` reads a prefix — a skill's frontmatter, not its whole body.
    async fn read_text(&self, path: &str, max_bytes: Option<usize>) -> anyhow::Result<String>;
    async fn read_bytes(&self, path: &str) -> anyhow::Result<Vec<u8>>;
    /// `mode` sets the read and write bits of a file this call creates.
    async fn write_text(&self, path: &str, content: &str, mode: Option<u32>) -> anyhow::Result<()>;
    async fn write_bytes(&self, path: &str, content: &[u8]) -> anyhow::Result<()>;
    /// Creates parents too.
    async fn mkdir(&self, path: &str) -> anyhow::Result<()>;
    /// A new, empty directory under the environment's temp dir that only this
    /// user can open.
    async fn make_temp_dir(&self, prefix: &str) -> anyhow::Result<String>;
    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()>;
    /// Follows symlinks.
    async fn stat(&self, path: &str) -> anyhow::Result<FileStat>;
    async fn lstat(&self, path: &str) -> anyhow::Result<FileStat>;
    async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<DirEntry>>;
    /// Recursive, and succeeds on a path that is already gone.
    async fn remove(&self, path: &str) -> anyhow::Result<()>;
    /// Only when the directory is empty.
    async fn remove_dir(&self, path: &str) -> anyhow::Result<()>;
    /// Point `link_path` at `target`, replacing whatever link is there.
    async fn symlink(&self, target: &str, link_path: &str) -> anyhow::Result<()>;
    /// The path with every link resolved. Fails when it does not exist.
    async fn realpath(&self, path: &str) -> anyhow::Result<String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub size: u64,
    /// Epoch milliseconds, fractional as Node's `mtimeMs`.
    pub mtime_ms: f64,
    pub is_file: bool,
    pub is_directory: bool,
    pub is_symbolic_link: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_file: bool,
    pub is_directory: bool,
    pub is_symbolic_link: bool,
}

/// The `std::io::ErrorKind` a file operation failed with, when it has one.
pub fn io_error_kind(err: &anyhow::Error) -> Option<std::io::ErrorKind> {
    err.chain()
        .find_map(|cause| cause.downcast_ref::<std::io::Error>())
        .map(|io| io.kind())
}
