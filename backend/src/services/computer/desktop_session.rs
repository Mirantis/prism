//! An XFCE desktop on the virtual display, so the screen the page shows is a desktop
//! with the agent's browser on it rather than a bare X root.
//!
//! The session bus is started here first, with `dbus-launch`, so its address is known
//! and can be handed to every program that should appear in the accessibility tree or
//! read it: the desktop, the browser, and the dump in `screen_elements.rs`. XFCE then
//! starts with accessibility switched on, and Plank is the dock along its bottom edge.
//! The desktop belongs to one voice chat and dies with it, bus included.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Weak};
use std::time::Duration;

use indexmap::IndexMap;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::json;

use super::child_process::{
    COMMAND_TIMEOUT_MS, ChildHandle, DEFAULT_MAX_BUFFER, ExecFileOptions, Pipes, StopSignal,
    exec_file, kill_pid, on_chunks, process_env, spawn_child,
};
use crate::lib::coding_agents::terminal::EXEC_SUBCOMMAND;
use crate::lib::data_dir::resolve_data_dir;
use crate::lib::execution_environments::execution_environment::ExecutionEnvironmentName;
use crate::lib::execution_environments::get_execution_environment::get_execution_environment;
use crate::lib::log_redaction::err_json;
use crate::{log_debug, log_warn};

/// How long a program gets to exit on SIGTERM before SIGKILL.
const EXIT_GRACE_MS: u64 = 3_000;
/// The dock's settings, which are per dock and so addressed by their path.
const DOCK_SETTINGS: &str = "net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/";
/// The dock's half of the desktop's theme; the image installs it.
const DOCK_THEME: &str = "Orchis";

/// The executable the wrappers run with `coding-agent-exec`: the runtime's own.
pub fn exec_entry() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("prism-server"))
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
    let environment = get_execution_environment();
    if environment.id() != ExecutionEnvironmentName::Local {
        return IndexMap::new();
    }
    let paths = environment.paths();
    let entry = entry.map_or_else(exec_entry, Path::to_path_buf);
    let wrappers_dir = wrappers_dir.map_or_else(
        || Path::new(&resolve_data_dir()).join("coding-agent-bin"),
        Path::to_path_buf,
    );
    let mut env = IndexMap::from([
        ("CLAUDE_CONFIG_DIR".to_string(), paths.claude_home),
        ("CODEX_HOME".to_string(), paths.codex_home),
    ]);
    env.extend(coding_agent_wrappers(&entry, &wrappers_dir));
    env
}

/// `value` in single quotes for `sh`, with each `'` written as `'\''`.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Writes the `claude` and `codex` wrappers, each an exec of `coding-agent-exec`
/// given their directory, and returns the PATH that finds them first.
fn coding_agent_wrappers(entry: &Path, dir: &Path) -> IndexMap<String, String> {
    let written = (|| -> anyhow::Result<()> {
        std::fs::create_dir_all(dir)?;
        for command in ["claude", "codex"] {
            let target = dir.join(command);
            // Renamed into place, so a terminal starting one never reads half a file.
            let staged = PathBuf::from(format!("{}.{}.tmp", target.display(), std::process::id()));
            let exec = [
                entry.display().to_string(),
                EXEC_SUBCOMMAND.to_string(),
                "--wrappers".to_string(),
                dir.display().to_string(),
                command.to_string(),
            ]
            .iter()
            .map(|part| shell_quote(part))
            .collect::<Vec<_>>()
            .join(" ");
            std::fs::write(&staged, format!("#!/bin/sh\nexec {exec} \"$@\"\n"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
            }
            std::fs::rename(&staged, &target)?;
        }
        Ok(())
    })();
    if let Err(err) = written {
        log_warn!(
            json!({ "err": err_json(&err) }),
            "[VoiceChat] Could not write the desktop terminal's coding agent wrappers"
        );
        return IndexMap::new();
    }
    let delimiter = if cfg!(windows) { ";" } else { ":" };
    let path = std::env::var("PATH").unwrap_or_default();
    IndexMap::from([(
        "PATH".to_string(),
        format!("{}{delimiter}{path}", dir.display()),
    )])
}

static BUS_ADDRESS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"DBUS_SESSION_BUS_ADDRESS='([^']+)'").expect("valid regex"));
static BUS_PID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"DBUS_SESSION_BUS_PID=(\d+)").expect("valid regex"));

struct SessionProcesses {
    proc: Option<ChildHandle>,
    dock: Option<ChildHandle>,
    bus_pid: Option<i32>,
    /// The session bus address and the accessibility switches.
    bus_env: IndexMap<String, String>,
}

pub struct DesktopSession {
    /// This session, for the task that notices the desktop exiting.
    me: Weak<DesktopSession>,
    /// The virtual display's: DISPLAY, XDG_RUNTIME_DIR and the PulseAudio vars.
    env: IndexMap<String, String>,
    processes: Mutex<SessionProcesses>,
}

impl DesktopSession {
    /// `env` is the virtual display's: DISPLAY, XDG_RUNTIME_DIR and the PulseAudio vars.
    pub fn new(env: IndexMap<String, String>) -> Arc<Self> {
        Arc::new_cyclic(|me| DesktopSession {
            me: me.clone(),
            env,
            processes: Mutex::new(SessionProcesses {
                proc: None,
                dock: None,
                bus_pid: None,
                bus_env: IndexMap::new(),
            }),
        })
    }

    /// The session bus address and the accessibility switches. Every program that should
    /// show up in the accessibility tree, or read it, starts with these in its environment.
    /// Empty until `start` has run.
    pub fn bus_env(&self) -> IndexMap<String, String> {
        self.processes.lock().bus_env.clone()
    }

    /// `{ ...process.env, ...codingAgentTerminalEnv(), ...this.env, ...this.busEnv }`.
    fn program_env(&self) -> IndexMap<String, String> {
        let mut env = process_env(&coding_agent_terminal_env(None, None));
        env.extend(self.env.clone());
        env.extend(self.bus_env());
        env
    }

    /// Start the bus and the desktop. Resolves once both are up; the panel appears a moment
    /// later. Fails with `dbus-launch printed no session bus address` when it prints none.
    pub async fn start(&self) -> anyhow::Result<()> {
        let env = process_env(&self.env);
        let stdout = exec_file(
            "dbus-launch",
            &["--sh-syntax".to_string()],
            ExecFileOptions {
                env: &env,
                timeout_ms: 10_000,
                max_buffer: DEFAULT_MAX_BUFFER,
            },
        )
        .await?;
        let stdout = String::from_utf8_lossy(&stdout).into_owned();
        let address = BUS_ADDRESS.captures(&stdout).map(|m| m[1].to_string());
        let pid = BUS_PID
            .captures(&stdout)
            .and_then(|m| m[1].parse::<i32>().ok());
        let Some(address) = address else {
            anyhow::bail!("dbus-launch printed no session bus address");
        };
        {
            let mut processes = self.processes.lock();
            processes.bus_pid = pid;
            processes.bus_env = IndexMap::from([
                ("DBUS_SESSION_BUS_ADDRESS".to_string(), address),
                // GTK loads its accessibility bridge on these; Chromium and Qt read the
                // other two.
                ("GTK_MODULES".to_string(), "gail:atk-bridge".to_string()),
                ("ACCESSIBILITY_ENABLED".to_string(), "1".to_string()),
                ("QT_ACCESSIBILITY".to_string(), "1".to_string()),
            ]);
        }

        let spawned = spawn_child(
            "startxfce4",
            &[],
            &self.program_env(),
            Pipes {
                stdin: false,
                stdout: false,
                stderr: true,
            },
        );
        let (proc, pipes) = match spawned {
            Ok(spawned) => spawned,
            Err(err) => {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[VoiceChat] Desktop failed to start"
                );
                return Ok(());
            }
        };
        on_chunks(pipes.stderr, |chunk| {
            log_last_line("[VoiceChat:Desktop]", chunk);
        });
        let me = self.me.clone();
        let watched = proc.clone();
        tokio::spawn(async move {
            let exit = watched.wait().await;
            let Some(session) = me.upgrade() else {
                return;
            };
            let mut processes = session.processes.lock();
            if processes
                .proc
                .as_ref()
                .is_some_and(|proc| proc.same(&watched))
            {
                log_warn!(
                    "[VoiceChat] Desktop exited on its own ({})",
                    exit.describe()
                );
                processes.proc = None;
            }
        });
        self.processes.lock().proc = Some(proc);
        Ok(())
    }

    /// Start the dock, replacing the one already running.
    ///
    /// Plank places itself against the screen once, when it starts, and stays where it put
    /// itself when the screen changes size. The session therefore starts it after the screen
    /// is the size it will be shown at, and again each time that size changes.
    pub async fn start_dock(&self) -> anyhow::Result<()> {
        // The dock starts the terminal too.
        let env = self.program_env();
        let dock = self.processes.lock().dock.take();
        end_process(dock).await;
        // Plank hides itself when a window comes near, which on a desktop nobody sits at
        // reads as a dock that is not there, and it takes its own look rather than the
        // desktop's, so both are said here.
        for (key, value) in [("hide-mode", "none"), ("theme", DOCK_THEME)] {
            let args = [
                "set".to_string(),
                DOCK_SETTINGS.to_string(),
                key.to_string(),
                value.to_string(),
            ];
            let set = exec_file(
                "gsettings",
                &args,
                ExecFileOptions {
                    env: &env,
                    timeout_ms: COMMAND_TIMEOUT_MS,
                    max_buffer: DEFAULT_MAX_BUFFER,
                },
            )
            .await;
            if let Err(err) = set {
                log_debug!(
                    json!({ "err": err_json(&err) }),
                    "[VoiceChat] Could not set the dock's {}",
                    key
                );
            }
        }

        let spawned = spawn_child(
            "plank",
            &[],
            &env,
            Pipes {
                stdin: false,
                stdout: false,
                stderr: true,
            },
        );
        match spawned {
            Ok((proc, pipes)) => {
                on_chunks(pipes.stderr, |chunk| {
                    log_last_line("[VoiceChat:Dock]", chunk);
                });
                self.processes.lock().dock = Some(proc);
            }
            Err(err) => {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[VoiceChat] Dock failed to start"
                );
            }
        }
        Ok(())
    }

    /// Stop the dock and the desktop, then the bus. Idempotent, and never fails.
    pub async fn stop(&self) {
        let (dock, proc) = {
            let mut processes = self.processes.lock();
            (processes.dock.take(), processes.proc.take())
        };
        end_process(dock).await;
        end_process(proc).await;
        let bus_pid = self.processes.lock().bus_pid.take();
        if let Some(bus_pid) = bus_pid {
            // A bus that already left has nothing to stop.
            let _ = kill_pid(bus_pid);
        }
    }
}

/// The last line of a chunk a desktop program wrote to stderr, at debug level.
fn log_last_line(tag: &str, chunk: &[u8]) {
    let text = String::from_utf8_lossy(chunk);
    let line = crate::support::js::trim(&text);
    if !line.is_empty() {
        let last = line.split('\n').next_back().unwrap_or_default();
        log_debug!("{} {}", tag, last);
    }
}

/// SIGTERM, a moment to go, then SIGKILL.
///
/// The wait is on the process's exit, since a process that left on a signal reports no
/// exit code.
async fn end_process(proc: Option<ChildHandle>) {
    let Some(proc) = proc else {
        return;
    };
    if proc.has_exited() {
        return;
    }
    proc.kill(StopSignal::Term);
    let _ = tokio::time::timeout(Duration::from_millis(EXIT_GRACE_MS), proc.wait()).await;
    if !proc.has_exited() {
        proc.kill(StopSignal::Kill);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::execution_environments::get_execution_environment::set_execution_environment_for_tests;

    #[test]
    #[serial_test::serial(execution_environment)]
    fn points_the_terminals_coding_agents_at_the_homes_tasks_sign_in_to() {
        set_execution_environment_for_tests(None);
        let dir = tempfile::Builder::new()
            .prefix("prism-it's-")
            .tempdir()
            .unwrap();
        let wrappers = dir.path().join("bin");
        let env = coding_agent_terminal_env(Some(Path::new("/opt/prism-server")), Some(&wrappers));
        let paths = get_execution_environment().paths();
        assert_eq!(env.get("CLAUDE_CONFIG_DIR"), Some(&paths.claude_home));
        assert_eq!(env.get("CODEX_HOME"), Some(&paths.codex_home));
    }

    #[cfg(unix)]
    #[test]
    #[serial_test::serial(execution_environment)]
    fn puts_wrappers_first_on_the_path_that_run_the_entry_with_their_directory_the_command_and_its_arguments()
     {
        set_execution_environment_for_tests(None);
        let dir = tempfile::Builder::new()
            .prefix("prism-it's-")
            .tempdir()
            .unwrap();
        // Stands in for the runtime's executable: prints what it was given, one per line.
        let entry = dir.path().join("entry");
        std::fs::write(
            &entry,
            "#!/bin/sh\nfor arg in \"$@\"; do echo \"$arg\"; done\n",
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let wrappers = dir.path().join("bin");

        let env = coding_agent_terminal_env(Some(&entry), Some(&wrappers));

        assert_eq!(
            env["PATH"].split(':').next(),
            Some(wrappers.display().to_string().as_str())
        );
        for command in ["claude", "codex"] {
            let printed = std::process::Command::new(wrappers.join(command))
                .args(["-p", "it's here"])
                .output()
                .unwrap();
            let printed = String::from_utf8(printed.stdout).unwrap();
            let wrappers = wrappers.display().to_string();
            assert_eq!(
                printed.lines().collect::<Vec<_>>(),
                vec![
                    "coding-agent-exec",
                    "--wrappers",
                    wrappers.as_str(),
                    command,
                    "-p",
                    "it's here"
                ]
            );
        }
    }
}
