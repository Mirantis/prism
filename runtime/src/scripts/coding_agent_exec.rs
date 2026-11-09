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

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::Command;

use crate::lib::coding_agents::subscription::not_signed_in_message;
use crate::lib::coding_agents::terminal::{
    TerminalCommand, login_status_args, signed_in_to_subscription, terminal_agent, terminal_launch,
    terminal_uses_subscription, unreadable_switch_message,
};
use crate::lib::execution_environments::execution_environment::ProcessEnv;

const LOGIN_CHECK_TIMEOUT_MS: u64 = 30_000;

/// `path.delimiter`.
const PATH_DELIMITER: &str = if cfg!(windows) { ";" } else { ":" };

/// Where the child's standard streams go.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ChildStdio {
    /// The terminal's own streams.
    #[default]
    Inherit,
    /// Nowhere (tests).
    Ignore,
}

impl ChildStdio {
    fn stdio(self) -> Stdio {
        match self {
            ChildStdio::Inherit => Stdio::inherit(),
            ChildStdio::Ignore => Stdio::null(),
        }
    }
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
pub async fn main(argv: Vec<String>, env: ProcessEnv, io: Io) -> i32 {
    let mut parts = argv.into_iter();
    let flag = parts.next();
    let wrappers = parts.next().unwrap_or_default();
    let command = TerminalCommand::parse(parts.next().as_deref());
    let args: Vec<String> = parts.collect();
    let Some(command) =
        command.filter(|_| flag.as_deref() == Some("--wrappers") && !wrappers.is_empty())
    else {
        (io.stderr)("usage: coding-agent-exec --wrappers <dir> <claude|codex> [args…]");
        return 2;
    };
    let name = command.as_str();
    let agent = terminal_agent(command);
    let mut child_env = env.clone();
    let path = env
        .get("PATH")
        .map(String::as_str)
        .unwrap_or("")
        .split(PATH_DELIMITER)
        .filter(|dir| !dir.is_empty() && *dir != wrappers)
        .collect::<Vec<_>>()
        .join(PATH_DELIMITER);
    child_env.insert("PATH".to_string(), path);

    let (subscription, unreadable) = match terminal_uses_subscription(&env, agent) {
        Ok(subscription) => (subscription, None),
        Err(err) => (true, Some(err)),
    };
    let launch = terminal_launch(command, &args, &child_env, subscription);

    if launch.check_login {
        let mut status = Command::new(name);
        status
            .args(login_status_args(command))
            .env_clear()
            .envs(&launch.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let (stdout, stderr, exit_code) = match status.spawn() {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                (io.stderr)(&format!("{name}: command not found"));
                return 127;
            }
            Err(_) => (String::new(), String::new(), None),
            Ok(child) => match tokio::time::timeout(
                Duration::from_millis(LOGIN_CHECK_TIMEOUT_MS),
                child.wait_with_output(),
            )
            .await
            {
                Ok(Ok(output)) => (
                    String::from_utf8_lossy(&output.stdout).into_owned(),
                    String::from_utf8_lossy(&output.stderr).into_owned(),
                    output.status.code(),
                ),
                _ => (String::new(), String::new(), None),
            },
        };
        if !signed_in_to_subscription(command, &stdout, &stderr, exit_code) {
            let message = match &unreadable {
                Some(err) => unreadable_switch_message(command, err),
                None => not_signed_in_message(agent, None),
            };
            (io.stderr)(&message);
            return 1;
        }
    }

    let mut child = match Command::new(name)
        .args(&launch.args)
        .env_clear()
        .envs(&launch.env)
        .stdin(io.stdio.stdio())
        .stdout(io.stdio.stdio())
        .stderr(io.stdio.stdio())
        .spawn()
    {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            (io.stderr)(&format!("{name}: command not found"));
            return 127;
        }
        Err(err) => {
            (io.stderr)(&format!("{name}: {err}"));
            return 126;
        }
    };
    let status = wait_passing_signals(&mut child).await;
    match status {
        Ok(status) => exit_code_of(status),
        Err(err) => {
            (io.stderr)(&format!("{name}: {err}"));
            126
        }
    }
}

/// Waits for the child. The terminal sends Ctrl-C and Ctrl-\ to the whole
/// foreground group, the CLI included; passing them on would deliver them twice,
/// so they are taken and dropped. SIGTERM and SIGHUP are passed on.
#[cfg(unix)]
async fn wait_passing_signals(
    child: &mut tokio::process::Child,
) -> std::io::Result<std::process::ExitStatus> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut quit = signal(SignalKind::quit())?;
    let mut terminate = signal(SignalKind::terminate())?;
    let mut hangup = signal(SignalKind::hangup())?;
    let pid = child.id();
    let forward = |number: i32| {
        if let Some(pid) = pid {
            // SAFETY: `kill` takes a pid and a signal number and touches no memory.
            unsafe {
                libc::kill(pid as libc::pid_t, number);
            }
        }
    };
    loop {
        tokio::select! {
            status = child.wait() => return status,
            _ = interrupt.recv() => {}
            _ = quit.recv() => {}
            _ = terminate.recv() => forward(libc::SIGTERM),
            _ = hangup.recv() => forward(libc::SIGHUP),
        }
    }
}

#[cfg(not(unix))]
async fn wait_passing_signals(
    child: &mut tokio::process::Child,
) -> std::io::Result<std::process::ExitStatus> {
    child.wait().await
}

/// The exit code, or 128 + the number of the signal that ended the process.
fn exit_code_of(status: std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        128 + status.signal().unwrap_or(0)
    }
    #[cfg(not(unix))]
    {
        128
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use diesel::RunQueryDsl;
    use diesel::connection::SimpleConnection;
    use parking_lot::Mutex;

    use super::*;
    use crate::config::CodingAgentName;
    use crate::lib::coding_agents::claude_code::authenticated_home::SUBSCRIPTION_SETTINGS;
    use crate::lib::coding_agents::codex::credentials::SUBSCRIPTION_CONFIG_ARGS;

    /// A fake `claude` on the PATH: answers `auth status` with $FAKE_STATUS, and
    /// otherwise records its arguments and Bedrock switch in $FAKE_OUT.
    const FAKE_CLAUDE: &str = "#!/bin/sh\nif [ \"$1\" = auth ] && [ \"$2\" = status ]; then printf '%s' \"$FAKE_STATUS\"; exit 0; fi\nprintf '%s\\n' \"bedrock=$CLAUDE_CODE_USE_BEDROCK\" \"$@\" > \"$FAKE_OUT\"\nexit 7\n";

    /// A fake `codex`, as `claude` above: `login status` answers on stderr, as Codex does.
    const FAKE_CODEX: &str = "#!/bin/sh\nif [ \"$1\" = login ] && [ \"$2\" = status ]; then printf '%s\\n' \"$FAKE_STATUS\" >&2; exit 0; fi\nprintf '%s\\n' \"key=$OPENAI_API_KEY\" \"$@\" > \"$FAKE_OUT\"\nexit 7\n";

    struct Setup {
        dir: tempfile::TempDir,
        bin: String,
        wrappers: String,
        out: String,
        database_url: String,
        errors: Arc<Mutex<Vec<String>>>,
    }

    fn write_executable(path: &str, content: &str) {
        std::fs::write(path, content).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn setup() -> Setup {
        let dir = tempfile::Builder::new()
            .prefix("prism-exec-")
            .tempdir()
            .unwrap();
        let at = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
        let (bin, wrappers, out) = (at("bin"), at("wrappers"), at("out"));
        std::fs::create_dir(&bin).unwrap();
        std::fs::create_dir(&wrappers).unwrap();
        write_executable(&format!("{bin}/claude"), FAKE_CLAUDE);
        write_executable(&format!("{bin}/codex"), FAKE_CODEX);
        // Found first on the PATH, as the wrapper is, and named by the argument
        // alone: it must not run itself.
        for command in ["claude", "codex"] {
            write_executable(&format!("{wrappers}/{command}"), "#!/bin/sh\nexit 99\n");
        }
        let file = at("agent.db");
        crate::db::open_connection(&file)
            .unwrap()
            .batch_execute(
                "CREATE TABLE runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER)",
            )
            .unwrap();
        Setup {
            bin,
            wrappers,
            out,
            database_url: format!("file:{file}"),
            errors: Arc::default(),
            dir,
        }
    }

    impl Setup {
        fn switch_on(&self) {
            let mut conn =
                crate::db::open_connection(self.database_url.strip_prefix("file:").unwrap())
                    .unwrap();
            diesel::sql_query(
                "INSERT INTO runtime_state VALUES ('codingAgentSubscription:claude-code', 'on', 0)",
            )
            .execute(&mut conn)
            .unwrap();
        }

        async fn run(&self, args: &[&str], extra: &[(&str, &str)], command: &str) -> i32 {
            let mut env = ProcessEnv::new();
            env.insert(
                "PATH".into(),
                format!("{}:{}:/usr/bin:/bin", self.wrappers, self.bin),
            );
            env.insert("CLAUDE_CODE_USE_BEDROCK".into(), "1".into());
            env.insert("OPENAI_API_KEY".into(), "sk-test".into());
            env.insert("DATABASE_URL".into(), self.database_url.clone());
            env.insert("FAKE_OUT".into(), self.out.clone());
            for (key, value) in extra {
                env.insert(key.to_string(), value.to_string());
            }
            let mut argv = vec![
                "--wrappers".to_string(),
                self.wrappers.clone(),
                command.to_string(),
            ];
            argv.extend(args.iter().map(|a| a.to_string()));
            let errors = self.errors.clone();
            main(
                argv,
                env,
                Io {
                    stdio: ChildStdio::Ignore,
                    stderr: Arc::new(move |line| errors.lock().push(line.to_string())),
                },
            )
            .await
        }

        fn recorded(&self) -> Vec<String> {
            std::fs::read_to_string(&self.out)
                .unwrap()
                .trim()
                .split('\n')
                .map(str::to_string)
                .collect()
        }

        fn gone(&self) -> String {
            format!("file:{}", self.dir.path().join("gone.db").display())
        }
    }

    const SUBSCRIBED: &str =
        r#"{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}"#;
    const SIGNED_OUT: &str = r#"{"loggedIn":false}"#;

    #[tokio::test]
    async fn runs_on_the_deployments_models_with_the_switch_off_and_passes_the_exit_code_on() {
        let setup = setup();
        assert_eq!(setup.run(&["-p", "hi"], &[], "claude").await, 7);
        assert_eq!(setup.recorded(), ["bedrock=1", "-p", "hi"]);
        assert!(setup.errors.lock().is_empty());
    }

    #[tokio::test]
    async fn runs_on_the_subscription_alone_with_the_switch_on_and_the_subscription_signed_in() {
        let setup = setup();
        setup.switch_on();
        assert_eq!(
            setup
                .run(&["-p", "hi"], &[("FAKE_STATUS", SUBSCRIBED)], "claude")
                .await,
            7
        );
        assert_eq!(
            setup.recorded(),
            [
                "bedrock=",
                "--settings",
                SUBSCRIPTION_SETTINGS.as_str(),
                "-p",
                "hi"
            ]
        );
    }

    #[tokio::test]
    async fn refuses_with_the_switch_on_and_nobody_signed_in_as_a_task_does() {
        let setup = setup();
        setup.switch_on();
        assert_eq!(
            setup
                .run(&[], &[("FAKE_STATUS", SIGNED_OUT)], "claude")
                .await,
            1
        );
        assert!(!std::path::Path::new(&setup.out).exists());
        assert_eq!(
            *setup.errors.lock(),
            [not_signed_in_message(CodingAgentName::ClaudeCode, None)]
        );
    }

    #[tokio::test]
    async fn lets_the_person_sign_in_from_the_terminal_with_the_switch_on() {
        let setup = setup();
        setup.switch_on();
        assert_eq!(
            setup
                .run(&["auth", "login"], &[("FAKE_STATUS", SIGNED_OUT)], "claude")
                .await,
            7
        );
        assert_eq!(setup.recorded(), ["bedrock=", "auth", "login"]);
    }

    #[tokio::test]
    async fn runs_on_the_subscription_signed_in_when_the_setting_cannot_be_read_and_refuses_with_nobody_signed_in()
     {
        let setup = setup();
        let gone = setup.gone();
        assert_eq!(
            setup
                .run(
                    &["-p", "hi"],
                    &[("DATABASE_URL", &gone), ("FAKE_STATUS", SUBSCRIBED)],
                    "claude"
                )
                .await,
            7
        );
        assert_eq!(
            setup.recorded(),
            [
                "bedrock=",
                "--settings",
                SUBSCRIPTION_SETTINGS.as_str(),
                "-p",
                "hi"
            ]
        );
        assert!(setup.errors.lock().is_empty());

        std::fs::remove_file(&setup.out).unwrap();
        assert_eq!(
            setup
                .run(
                    &[],
                    &[("DATABASE_URL", &gone), ("FAKE_STATUS", SIGNED_OUT)],
                    "claude"
                )
                .await,
            1
        );
        assert!(!std::path::Path::new(&setup.out).exists());
        let errors = setup.errors.lock();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].starts_with("claude: could not read the Coding agents setting ("));
        assert!(
            errors[0].ends_with(
                "), and no Claude subscription is signed in: sign in from Coding agents"
            )
        );
    }

    #[tokio::test]
    async fn does_the_same_for_codex_when_the_setting_cannot_be_read() {
        let setup = setup();
        let gone = setup.gone();
        assert_eq!(
            setup
                .run(
                    &["exec", "hi"],
                    &[
                        ("DATABASE_URL", &gone),
                        ("FAKE_STATUS", "Logged in using ChatGPT")
                    ],
                    "codex"
                )
                .await,
            7
        );
        let mut expected = vec!["key=".to_string()];
        expected.extend(SUBSCRIPTION_CONFIG_ARGS.iter().map(|a| a.to_string()));
        expected.extend(["exec".to_string(), "hi".to_string()]);
        assert_eq!(setup.recorded(), expected);

        std::fs::remove_file(&setup.out).unwrap();
        assert_eq!(
            setup
                .run(
                    &["exec", "hi"],
                    &[("DATABASE_URL", &gone), ("FAKE_STATUS", "Not logged in")],
                    "codex"
                )
                .await,
            1
        );
        assert!(!std::path::Path::new(&setup.out).exists());
        let errors = setup.errors.lock();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].starts_with("codex: could not read the Coding agents setting "));
        assert!(errors[0].contains("no ChatGPT subscription is signed in"));
    }

    #[tokio::test]
    async fn answers_127_when_the_real_binary_is_not_installed() {
        let setup = setup();
        std::fs::remove_file(format!("{}/claude", setup.bin)).unwrap();
        assert_eq!(setup.run(&[], &[], "claude").await, 127);
        assert_eq!(*setup.errors.lock(), ["claude: command not found"]);
    }

    #[tokio::test]
    async fn prints_the_usage_for_anything_else() {
        let errors: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = errors.clone();
        let code = main(
            vec!["--wrappers".into(), "/w".into(), "vim".into()],
            ProcessEnv::new(),
            Io {
                stdio: ChildStdio::Ignore,
                stderr: Arc::new(move |line| sink.lock().push(line.to_string())),
            },
        )
        .await;
        assert_eq!(code, 2);
        assert_eq!(
            *errors.lock(),
            ["usage: coding-agent-exec --wrappers <dir> <claude|codex> [args…]"]
        );
    }
}
