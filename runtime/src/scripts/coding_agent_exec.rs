//! What the desktop terminal's `claude` and `codex` run: the wrappers the
//! desktop session puts first on the desktop's PATH exec
//! `coding-agent-exec --wrappers <dir> <claude|codex> [args…]`.
//!
//! It reads the subscription switch from the runtime's database, read-only,
//! builds the environment the way a task does, and runs the real binary from
//! the PATH without the wrappers' directory. With the switch on and nobody
//! signed in it refuses, as a task does, rather than run on the deployment's
//! models. When the database can't be read it runs as with the switch on: on
//! the subscription signed in, or not at all. Only a switch read as off runs on
//! the deployment's models.

use std::collections::HashMap;
use std::sync::Arc;

const LOGIN_CHECK_TIMEOUT_MS: i64 = 30_000;

/// Where the child's standard streams go.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ChildStdio {
    /// The terminal's own streams.
    #[default]
    Inherit,
    /// Nowhere (tests).
    Ignore,
}

/// The streams `main` uses: the child's, and where its own error lines go.
#[derive(Clone)]
pub struct Io {
    pub stdio: ChildStdio,
    /// Writes one line, without its newline.
    pub stderr: Arc<dyn Fn(&str) + Send + Sync>,
}

impl Default for Io {
    fn default() -> Self {
        Self {
            stdio: ChildStdio::Inherit,
            stderr: Arc::new(|line| eprintln!("{line}")),
        }
    }
}

/// Runs the wrapped command and returns its exit code.
///
/// `argv` is `--wrappers <dir> <claude|codex> [args…]`; anything else prints
/// `usage: coding-agent-exec --wrappers <dir> <claude|codex> [args…]` and returns 2.
/// The child's PATH is `env`'s PATH without empty entries and without the wrappers'
/// dir. The switch is `terminal_uses_subscription(env, agent)`; when that fails the
/// switch reads as on and the error is kept. `terminal_launch` gives the args, the
/// env and whether to check the login: a login check runs the command with
/// `login_status_args` for up to `LOGIN_CHECK_TIMEOUT_MS`; a missing binary prints
/// `<command>: command not found` and returns 127; a check
/// `signed_in_to_subscription` refuses prints `unreadable_switch_message` (when the
/// switch could not be read) or `not_signed_in_message(agent)` and returns 1.
/// Then the command runs with the launch's args and env. SIGINT and SIGQUIT are
/// ignored while it runs (the terminal sends them to the whole foreground group),
/// and SIGTERM and SIGHUP are passed on. A spawn error prints
/// `<command>: command not found` (127) or `<command>: <message>` (126); otherwise
/// the result is the exit code, or 128 + the signal number.
pub async fn main(argv: Vec<String>, env: HashMap<String, String>, io: Io) -> i32 {
    todo!()
}
