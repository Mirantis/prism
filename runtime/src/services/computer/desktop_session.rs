//! An XFCE desktop on the virtual display, so the screen the page shows is a desktop
//! with the agent's browser on it rather than a bare X root.
//!
//! The session bus is started here first, with `dbus-launch`, so its address is known
//! and can be handed to every program that should appear in the accessibility tree or
//! read it: the desktop, the browser, and the dump in `screen_elements.rs`. XFCE then
//! starts with accessibility switched on, and Plank is the dock along its bottom edge.
//! The desktop belongs to one voice chat and dies with it, bus included.

use std::collections::HashMap;

use indexmap::IndexMap;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use tokio::process::Child;

/// How long a program gets to exit on SIGTERM before SIGKILL.
const EXIT_GRACE_MS: u64 = 3_000;
const COMMAND_TIMEOUT_MS: u64 = 10_000;
/// The dock's settings, which are per dock and so addressed by their path.
const DOCK_SETTINGS: &str = "net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/";
/// The dock's half of the desktop's theme; the image installs it.
const DOCK_THEME: &str = "Orchis";

/// The built `coding-agent-exec` entry the wrappers run: `scripts/coding-agent-exec.js`
/// beside the runtime. Absent under a development run and in the packaged binary.
pub fn exec_entry() -> PathBuf {
    todo!()
}

/// `claude` and `codex` in the desktop's terminal: the homes a sign-in from
/// Coding agents saved the login to, and wrappers first on the PATH that apply
/// the subscription switch the way tasks do. Only when tasks run in this
/// container: a docker environment's homes are paths in another one.
///
/// `entry` defaults to `exec_entry()` and `wrappers_dir` to `<data dir>/coding-agent-bin`.
pub fn coding_agent_terminal_env(
    entry: Option<&Path>,
    wrappers_dir: Option<&Path>,
) -> IndexMap<String, String> {
    todo!()
}

/// `value` in single quotes for `sh`, with each `'` written as `'\''`.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Writes the `claude` and `codex` wrappers, each an exec of `coding-agent-exec`
/// given their directory, and returns the PATH that finds them first. Nothing
/// without the built entry.
fn coding_agent_wrappers(entry: &Path, dir: &Path) -> IndexMap<String, String> {
    todo!()
}

struct SessionProcesses {
    proc: Option<Child>,
    dock: Option<Child>,
    bus_pid: Option<i32>,
    /// The session bus address and the accessibility switches.
    bus_env: IndexMap<String, String>,
}

pub struct DesktopSession {
    /// The virtual display's: DISPLAY, XDG_RUNTIME_DIR and the PulseAudio vars.
    env: IndexMap<String, String>,
    processes: Mutex<SessionProcesses>,
}

impl DesktopSession {
    /// `env` is the virtual display's: DISPLAY, XDG_RUNTIME_DIR and the PulseAudio vars.
    pub fn new(env: IndexMap<String, String>) -> Self {
        DesktopSession {
            env,
            processes: Mutex::new(SessionProcesses {
                proc: None,
                dock: None,
                bus_pid: None,
                bus_env: IndexMap::new(),
            }),
        }
    }

    /// The session bus address and the accessibility switches. Every program that should
    /// show up in the accessibility tree, or read it, starts with these in its environment.
    /// Empty until `start` has run.
    pub fn bus_env(&self) -> IndexMap<String, String> {
        self.processes.lock().bus_env.clone()
    }

    /// Start the bus and the desktop. Resolves once both are up; the panel appears a moment
    /// later. Fails with `dbus-launch printed no session bus address` when it prints none.
    pub async fn start(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Start the dock, replacing the one already running.
    ///
    /// Plank places itself against the screen once, when it starts, and stays where it put
    /// itself when the screen changes size. The session therefore starts it after the screen
    /// is the size it will be shown at, and again each time that size changes.
    pub async fn start_dock(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Stop the dock and the desktop, then the bus. Idempotent, and never fails.
    pub async fn stop(&self) {
        todo!()
    }
}

/// SIGTERM, a moment to go, then SIGKILL.
///
/// The wait is on the process's exit, since a process that left on a signal reports no
/// exit code.
async fn end_process(proc: Option<Child>) {
    todo!()
}
