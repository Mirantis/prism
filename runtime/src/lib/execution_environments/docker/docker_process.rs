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
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use parking_lot::Mutex;
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_util::io::StreamReader;

use super::container_lost::report_if_container_lost;
use super::engine::DOCKER;
use crate::lib::execution_environments::execution_environment::{
    ExecEnd, ExecOutput, ExecProcess, ExecStdin, ProcessMark, RunOptions, Signal, StdinMode,
};
use crate::lib::execution_environments::local::local_env::process_env;
use crate::lib::execution_environments::local::local_process::run_local_program;
use crate::lib::log_redaction::err_json;
use crate::log_warn;

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

/// This process's working directory, where the engine's client starts: a host
/// directory, since the command's own cwd is a path inside the container.
pub(crate) fn host_cwd() -> String {
    std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_string())
}

/// `docker exec [-i] -w <cwd> -e NAME… <container> setsid --wait bash -c
/// RECORD_PGID prism-exec <pid file> <payload…>`.
///
/// `-e NAME` without a value tells the engine to take it from its own client's
/// environment, so a credential reaches the container without appearing in an
/// argv. `--wait` is relied on: under `docker exec` the entered process is
/// already a process-group leader, so `setsid` forks instead of exec'ing —
/// without it the parent exits 0 the moment the child starts, the engine's
/// client returns, and the command's output is read as empty while the work
/// runs on detached. With it, setsid waits and reports the child's status.
pub fn exec_argv(
    payload: &[String],
    options: &RunOptions,
    container: &str,
    pid_file: &str,
) -> Vec<String> {
    let mut argv = vec!["exec".to_string()];
    if options.stdin == StdinMode::Pipe {
        argv.push("-i".to_string());
    }
    argv.push("-w".to_string());
    argv.push(options.cwd.clone());
    for name in options.env.keys() {
        argv.push("-e".to_string());
        argv.push(name.clone());
    }
    argv.extend(
        [
            container,
            "setsid",
            "--wait",
            "bash",
            "-c",
            RECORD_PGID,
            // `$0` for the wrapper; only its name shows up in the container's ps.
            "prism-exec",
            pid_file,
        ]
        .map(str::to_string),
    );
    argv.extend(payload.iter().cloned());
    argv
}

/// `docker exec <container> sh -c SIGNAL_GROUP prism-kill <pid file> <name>`.
pub fn kill_argv(container: &str, pid_file: &str, signal_name: &str) -> Vec<String> {
    [
        "exec",
        container,
        "sh",
        "-c",
        SIGNAL_GROUP,
        "prism-kill",
        pid_file,
        signal_name,
    ]
    .map(str::to_string)
    .to_vec()
}

/// Its client a local program started in this process's cwd with
/// `{ …this process's env, …options.env }`. `stdin` follows the caller: `Pipe`
/// connects our stdin to the client, and `-i` passes it on into the container.
fn exec(
    payload: Vec<String>,
    options: RunOptions,
    ctx: &DockerExecContext,
) -> Arc<dyn ExecProcess> {
    let pid_file = pid_file_for(&uuid::Uuid::new_v4().to_string());
    let argv = exec_argv(&payload, &options, &ctx.container, &pid_file);

    let mut env = process_env();
    env.extend(options.env.clone());
    let client = run_local_program(
        DOCKER,
        &argv,
        RunOptions {
            cwd: host_cwd(),
            env,
            stdin: options.stdin,
        },
        false,
    );
    let stderr = watch_for_lost_container(&client, &ctx.container);

    Arc::new(DockerProcess {
        client,
        container: ctx.container.clone(),
        pid_file,
        stderr: Mutex::new(stderr),
    })
}

/// A command in the container: the engine client's streams and end, and a kill
/// that reaches the payload's process group.
pub struct DockerProcess {
    pub(crate) client: Arc<dyn ExecProcess>,
    pub(crate) container: String,
    pub(crate) pid_file: String,
    /// The client's stderr, passed on by `watch_for_lost_container`.
    pub(crate) stderr: Mutex<Option<ExecOutput>>,
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
        self.stderr.lock().take()
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

/// Warn when the engine answers that the container is gone.
///
/// The client's stderr is read here and passed on to the caller, so it is read
/// whether or not the caller reads it. Only the head is kept, since the engine
/// writes its error before the command could have written anything; it goes to
/// `report_if_container_lost` once the client exits non-zero and its stderr has
/// ended, so the engine's whole error is in it.
fn watch_for_lost_container(client: &Arc<dyn ExecProcess>, container: &str) -> Option<ExecOutput> {
    let mut source = client.take_stderr()?;
    let (tx, rx) = mpsc::unbounded_channel::<std::io::Result<Bytes>>();
    let pump = tokio::spawn(async move {
        let mut head: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; 16 * 1024];
        loop {
            match source.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if head.len() < ENGINE_ERROR_BYTES {
                        head.extend_from_slice(&chunk[..n]);
                    }
                    let _ = tx.send(Ok(Bytes::copy_from_slice(&chunk[..n])));
                }
            }
        }
        head
    });

    let client = client.clone();
    let container = container.to_string();
    tokio::spawn(async move {
        let end = client.ended().await;
        let head = pump.await.unwrap_or_default();
        if end.exit_code == Some(0) {
            return;
        }
        report_if_container_lost(&container, &String::from_utf8_lossy(&head));
    });

    Some(Box::pin(StreamReader::new(UnboundedReceiverStream::new(rx))) as ExecOutput)
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
/// `kill` accepts, while the separate binaries disagree — Debian's procps
/// rejects `kill -SIGKILL` and wants `--` before a negative pid.
fn kill_payload(container: &str, pid_file: &str, signal: Signal, client: &dyn ExecProcess) -> bool {
    let full = signal.as_str();
    let name = full.strip_prefix("SIG").unwrap_or(full);
    let argv = kill_argv(container, pid_file, name);

    if tokio::runtime::Handle::try_current().is_ok() {
        let signaller = run_local_program(
            DOCKER,
            &argv,
            RunOptions {
                cwd: host_cwd(),
                env: process_env(),
                stdin: StdinMode::Ignore,
            },
            false,
        );
        let container = container.to_string();
        tokio::spawn(async move {
            let end = tokio::select! {
                end = signaller.ended() => end,
                _ = tokio::time::sleep(Duration::from_millis(KILL_TIMEOUT_MS)) => {
                    signaller.kill(Signal::SIGKILL);
                    signaller.ended().await
                }
            };
            // Exit 1 is the ordinary "nothing to signal": the command ended between
            // the decision and the signal. Anything else is worth a line.
            if let Some(err) = end.error {
                log_warn!(
                    json!({ "err": err_json(&err), "container": container }),
                    "[Docker] could not signal"
                );
            }
        });
    } else {
        // The runtime is exiting and no longer runs tasks: the signaller is
        // started and left to finish on its own.
        let _ = std::process::Command::new(DOCKER)
            .args(&argv)
            .current_dir(host_cwd())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }

    if signal == Signal::SIGKILL {
        return client.kill(signal);
    }
    true
}

#[cfg(test)]
mod tests {
    //! The argv handed to the engine, and the kill that has to reach inside it.
    //! The engine itself is never run, so these cases say the same thing on a
    //! machine with an engine and one without.

    use indexmap::IndexMap;

    use super::*;

    fn options(stdin: StdinMode, env: &[(&str, &str)]) -> RunOptions {
        RunOptions {
            cwd: "/data/workspace".to_string(),
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<IndexMap<_, _>>(),
            stdin,
        }
    }

    fn shell_payload(command: &str) -> Vec<String> {
        vec!["bash".into(), "-c".into(), command.into()]
    }

    /// The pid file the wrapper was told to write, read out of its argv.
    fn pid_file_of(args: &[String]) -> String {
        let at = args.iter().position(|a| a == "prism-exec").unwrap();
        args[at + 1].clone()
    }

    #[test]
    fn enters_the_container_at_the_caller_cwd_and_records_its_process_group() {
        let pid_file = pid_file_for(&uuid::Uuid::new_v4().to_string());
        let args = exec_argv(
            &shell_payload("echo hi"),
            &options(StdinMode::Ignore, &[]),
            "agent-exec-test",
            &pid_file,
        );
        assert_eq!(
            &args[..4],
            &["exec", "-w", "/data/workspace", "agent-exec-test"]
        );
        let setsid = args.iter().position(|a| a == "setsid").unwrap();
        assert_eq!(args[setsid + 1], "--wait");
        let file = pid_file_of(&args);
        let pattern = regex::Regex::new(r"^/tmp/prism-exec-[0-9a-f-]{36}\.pid$").unwrap();
        assert!(pattern.is_match(&file), "{file}");
        assert_eq!(&args[args.len() - 3..], &["bash", "-c", "echo hi"]);
    }

    #[test]
    fn runs_a_program_by_argv_with_no_shell_in_between() {
        let payload = vec!["claude".to_string(), "-p".into(), "do X".into()];
        let args = exec_argv(
            &payload,
            &options(StdinMode::Ignore, &[]),
            "agent-exec-test",
            "/tmp/x.pid",
        );
        assert_eq!(&args[args.len() - 3..], &["claude", "-p", "do X"]);
    }

    #[test]
    fn attaches_stdin_only_when_the_caller_asked_to_write_to_it() {
        let piped = exec_argv(
            &shell_payload("cat"),
            &options(StdinMode::Pipe, &[]),
            "c",
            "/tmp/x.pid",
        );
        assert!(piped.contains(&"-i".to_string()));
        let ignored = exec_argv(
            &shell_payload("cat"),
            &options(StdinMode::Ignore, &[]),
            "c",
            "/tmp/x.pid",
        );
        assert!(!ignored.contains(&"-i".to_string()));
    }

    #[test]
    fn names_each_variable_but_never_its_value() {
        // A token in an argv is a token in the host's `ps`. `-e NAME` makes the
        // engine read it from its own client's environment instead.
        let args = exec_argv(
            &shell_payload("aws s3 ls"),
            &options(
                StdinMode::Ignore,
                &[("AWS_BEARER_TOKEN_BEDROCK", "test-token")],
            ),
            "c",
            "/tmp/x.pid",
        );
        let at = args.iter().position(|a| a == "-e").unwrap();
        assert_eq!(args[at + 1], "AWS_BEARER_TOKEN_BEDROCK");
        assert!(!args.join(" ").contains("test-token"));
    }

    #[test]
    fn reads_the_recorded_group_id_in_the_container_and_signals_the_group() {
        let args = kill_argv("agent-exec-test", "/tmp/prism-exec-1.pid", "TERM");
        assert_eq!(&args[..4], &["exec", "agent-exec-test", "sh", "-c"]);
        assert_eq!(args[5], "prism-kill");
        assert_eq!(args[6], "/tmp/prism-exec-1.pid");
        assert_eq!(args[7], "TERM");
        // Read on the container's side, because the file is the container's.
        assert!(args[4].contains("cat \"$1\""));
        // A negative pid: the group, so a grandchild of the command dies with it.
        assert!(args[4].contains("kill -\"$2\" -\"$p\""));
    }

    #[test]
    fn gives_each_command_a_pid_file_of_its_own() {
        let one = pid_file_for(&uuid::Uuid::new_v4().to_string());
        let two = pid_file_for(&uuid::Uuid::new_v4().to_string());
        assert_ne!(one, two);
    }

    #[cfg(unix)]
    #[test]
    fn the_wrapper_records_its_group_and_the_kill_reaches_it() {
        // The two scripts, run by a real shell here as the container would.
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("group.pid");
        let pid_file = pid_file.to_string_lossy().into_owned();
        let mut child = std::process::Command::new("setsid")
            .args(["bash", "-c", RECORD_PGID, "prism-exec", &pid_file, "sleep", "30"])
            .spawn()
            .or_else(|_| {
                // No `setsid` binary on this host: the wrapper alone, in a group of its own.
                use std::os::unix::process::CommandExt;
                std::process::Command::new("bash")
                    .args(["-c", RECORD_PGID, "prism-exec", &pid_file, "sleep", "30"])
                    .process_group(0)
                    .spawn()
            })
            .unwrap();
        for _ in 0..100 {
            if std::fs::read_to_string(&pid_file).is_ok_and(|p| !p.trim().is_empty()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let args = kill_argv("unused", &pid_file, "KILL");
        let status = std::process::Command::new("sh")
            .args(&args[3..])
            .status()
            .unwrap();
        assert!(status.success());
        let ended = child.wait().unwrap();
        assert!(!ended.success());
    }

    #[tokio::test]
    async fn reports_a_launch_failure_as_the_end_of_the_process() {
        // The engine's client is an ordinary local program, so a client that
        // cannot start ends the process with that error rather than failing.
        let proc = run_local_program(
            "definitely-not-docker-x9",
            &[],
            options(StdinMode::Ignore, &[]),
            false,
        );
        let end = proc.ended().await;
        assert_eq!(
            end.error.unwrap().to_string(),
            "spawn definitely-not-docker-x9 ENOENT"
        );
    }
}
