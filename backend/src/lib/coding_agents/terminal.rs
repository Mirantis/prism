//! `claude` and `codex` in the desktop's terminal follow the same subscription
//! switch as tasks: on it, the saved login and nothing that outranks it, and a
//! refusal when nobody is signed in; off it, the deployment's models.
//!
//! Reads nothing of the configuration, so `coding-agent-exec` uses it without
//! starting the runtime.

use diesel::connection::SimpleConnection;
use diesel::sql_types::Text;
use diesel::{QueryableByName, RunQueryDsl};

use crate::config::CodingAgentName;
use crate::lib::execution_environments::execution_environment::ProcessEnv;
use crate::lib::sqlite_path::resolve_prisma_sqlite_path;

use super::subscription::{subscription_forced_in, subscription_key};

use super::claude_code::authenticated_home::{
    AUTH_STATUS_ARGS, SUBSCRIPTION_SETTINGS, SavedLogin, saved_login_from_status,
};
use super::claude_code::environment::claude_code_launch_environment;
use super::codex::credentials::{
    LOGIN_STATUS_ARGS, SUBSCRIPTION_CONFIG_ARGS, SavedCodexLogin, codex_login_from_status,
    subscription_environment as codex_subscription_environment,
};

/// The subcommand of the runtime's own executable that runs a coding agent for the
/// desktop's terminal.
pub const EXEC_SUBCOMMAND: &str = "coding-agent-exec";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TerminalCommand {
    Claude,
    Codex,
}

impl TerminalCommand {
    pub fn as_str(self) -> &'static str {
        match self {
            TerminalCommand::Claude => "claude",
            TerminalCommand::Codex => "codex",
        }
    }
}

/// The coding agent each terminal command runs (`claude` → `claude-code`,
/// `codex` → `codex`).
pub fn terminal_agent(command: TerminalCommand) -> CodingAgentName {
    match command {
        TerminalCommand::Claude => CodingAgentName::ClaudeCode,
        TerminalCommand::Codex => CodingAgentName::Codex,
    }
}

impl TerminalCommand {
    /// The command a word names, when it names one.
    pub fn parse(value: Option<&str>) -> Option<TerminalCommand> {
        match value {
            Some("claude") => Some(TerminalCommand::Claude),
            Some("codex") => Some(TerminalCommand::Codex),
            _ => None,
        }
    }
}

/// Claude Code 2.1's subcommands: none of them is a session, so none takes `--settings`.
/// A subcommand missing here runs as a session: it gets `--settings` and needs
/// the subscription signed in. Update the list from `claude --help` when the
/// image's Claude Code adds one.
pub const CLAUDE_SUBCOMMANDS: &[&str] = &[
    "agents",
    "attach",
    "auth",
    "auto-mode",
    "doctor",
    "gateway",
    "import",
    "install",
    "logs",
    "mcp",
    "plugin",
    "plugins",
    "purge",
    "respawn",
    "rm",
    "setup-token",
    "stop",
    "kill",
    "ultrareview",
    "update",
    "upgrade",
    "help",
];

/// Codex's subcommands that never ask a model, so need nobody signed in.
pub const CODEX_WITHOUT_MODEL: &[&str] = &[
    "login",
    "logout",
    "completion",
    "help",
    "mcp",
    "features",
    "debug",
    "sandbox",
    "doctor",
    "update",
];

pub const ASKS_ABOUT_THE_CLI: &[&str] = &["-h", "--help", "-v", "-V", "--version"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalLaunch {
    pub env: ProcessEnv,
    pub args: Vec<String>,
    /// Whether it may run only with the subscription signed in.
    pub check_login: bool,
}

/// How `command args` runs in the terminal with the switch on or off.
pub fn terminal_launch(
    command: TerminalCommand,
    args: &[String],
    env: &ProcessEnv,
    subscription: bool,
) -> TerminalLaunch {
    let about_the_cli = args
        .iter()
        .any(|arg| ASKS_ABOUT_THE_CLI.contains(&arg.as_str()));
    let first = args.first().map(String::as_str).unwrap_or("");
    match command {
        TerminalCommand::Claude => {
            let launch_env = claude_code_launch_environment(env, subscription);
            let session = subscription && !CLAUDE_SUBCOMMANDS.contains(&first) && !about_the_cli;
            // The same flag settings as a task, so a repository's settings can't
            // move the session off the login.
            let args = if session {
                let mut with = vec!["--settings".to_string(), SUBSCRIPTION_SETTINGS.clone()];
                with.extend(args.iter().cloned());
                with
            } else {
                args.to_vec()
            };
            TerminalLaunch {
                env: launch_env,
                args,
                check_login: session,
            }
        }
        TerminalCommand::Codex => {
            if !subscription {
                return TerminalLaunch {
                    env: env.clone(),
                    args: args.to_vec(),
                    check_login: false,
                };
            }
            let mut with: Vec<String> = SUBSCRIPTION_CONFIG_ARGS
                .iter()
                .map(|a| a.to_string())
                .collect();
            with.extend(args.iter().cloned());
            TerminalLaunch {
                env: codex_subscription_environment(env),
                args: with,
                check_login: !CODEX_WITHOUT_MODEL.contains(&first) && !about_the_cli,
            }
        }
    }
}

/// The arguments that ask the CLI which login its home holds.
pub fn login_status_args(command: TerminalCommand) -> Vec<String> {
    let args: &[&str] = match command {
        TerminalCommand::Claude => AUTH_STATUS_ARGS,
        TerminalCommand::Codex => LOGIN_STATUS_ARGS,
    };
    args.iter().map(|a| a.to_string()).collect()
}

/// Whether the status the CLI printed is the subscription's login. An unreadable
/// status is not.
pub fn signed_in_to_subscription(
    command: TerminalCommand,
    stdout: &str,
    stderr: &str,
    exit_code: Option<i32>,
) -> bool {
    match command {
        TerminalCommand::Claude => {
            matches!(
                saved_login_from_status(stdout, exit_code),
                Ok(SavedLogin::Subscription)
            )
        }
        TerminalCommand::Codex => matches!(
            codex_login_from_status(&format!("{stdout}\n{stderr}"), exit_code),
            Ok(SavedCodexLogin::Chatgpt)
        ),
    }
}

/// Why the terminal refuses when it can't read the switch and no subscription is
/// signed in.
pub fn unreadable_switch_message(command: TerminalCommand, err: &anyhow::Error) -> String {
    let subscription = match command {
        TerminalCommand::Claude => "Claude subscription",
        TerminalCommand::Codex => "ChatGPT subscription",
    };
    format!(
        "{}: could not read the Coding agents setting ({err}), and no {subscription} is signed in: sign in from Coding agents",
        command.as_str()
    )
}

/// The switch as the runtime stored it, read from the runtime's database opened
/// read-only (`SELECT value FROM runtime_state WHERE key = ?`, a 2 s busy
/// timeout, the file required to exist). Fails when the database can't be read.
///
/// This raw read is a named exception to the no-hand-written-SQL rule: the
/// terminal's wrapper runs as a separate process that does not start the
/// database layer.
pub fn read_subscription_switch(
    database_url: Option<&str>,
    agent: CodingAgentName,
) -> anyhow::Result<bool> {
    let path = resolve_prisma_sqlite_path(database_url)?;
    let mut conn = crate::db::open_readonly(&path)?;
    conn.batch_execute("PRAGMA busy_timeout = 2000;")?;
    let rows: Vec<SwitchRow> = diesel::sql_query("SELECT value FROM runtime_state WHERE key = ?")
        .bind::<Text, _>(subscription_key(agent))
        .load(&mut conn)?;
    Ok(rows.first().is_some_and(|row| row.value == "on"))
}

#[derive(QueryableByName)]
struct SwitchRow {
    #[diesel(sql_type = Text)]
    value: String,
}

/// The switch for the terminal: held on by the environment, or as stored.
pub fn terminal_uses_subscription(
    env: &ProcessEnv,
    agent: CodingAgentName,
) -> anyhow::Result<bool> {
    if subscription_forced_in(env, agent) {
        return Ok(true);
    }
    read_subscription_switch(env.get("DATABASE_URL").map(String::as_str), agent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::coding_agents::testing::env_of;

    fn bedrock() -> ProcessEnv {
        env_of(&[
            ("PATH", "/usr/bin"),
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
            ("AWS_REGION", "eu-west-1"),
            ("OPENAI_API_KEY", "sk-test"),
        ])
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn runs_a_claude_session_on_the_saved_login_alone_with_the_switch_on() {
        let launch = terminal_launch(
            TerminalCommand::Claude,
            &strings(&["-p", "hi"]),
            &bedrock(),
            true,
        );
        assert!(!launch.env.contains_key("CLAUDE_CODE_USE_BEDROCK"));
        assert_eq!(
            launch.args,
            ["--settings", SUBSCRIPTION_SETTINGS.as_str(), "-p", "hi"]
        );
        assert!(launch.check_login);
    }

    #[test]
    fn leaves_claudes_subcommands_and_version_unchecked_so_a_person_can_sign_in_from_the_terminal()
    {
        for args in [
            vec!["auth", "login"],
            vec!["mcp", "list"],
            vec!["--version"],
        ] {
            let launch =
                terminal_launch(TerminalCommand::Claude, &strings(&args), &bedrock(), true);
            assert_eq!(launch.args, args);
            assert!(!launch.check_login);
            assert!(!launch.env.contains_key("CLAUDE_CODE_USE_BEDROCK"));
        }
    }

    #[test]
    fn runs_claude_on_the_deployments_models_with_the_switch_off() {
        let launch = terminal_launch(TerminalCommand::Claude, &[], &bedrock(), false);
        assert!(launch.args.is_empty());
        assert!(!launch.check_login);
        assert_eq!(launch.env["CLAUDE_CODE_USE_BEDROCK"], "1");
    }

    #[test]
    fn runs_codex_on_the_chatgpt_login_with_the_switch_on_and_checks_it_except_to_sign_in() {
        let session = terminal_launch(
            TerminalCommand::Codex,
            &strings(&["exec", "hi"]),
            &bedrock(),
            true,
        );
        assert!(!session.env.contains_key("OPENAI_API_KEY"));
        let mut expected = strings(SUBSCRIPTION_CONFIG_ARGS);
        expected.extend(strings(&["exec", "hi"]));
        assert_eq!(session.args, expected);
        assert!(
            session
                .args
                .contains(&"model_provider=\"openai\"".to_string())
        );
        assert!(session.check_login);
        assert!(
            !terminal_launch(
                TerminalCommand::Codex,
                &strings(&["login", "--device-auth"]),
                &bedrock(),
                true
            )
            .check_login
        );
    }

    #[test]
    fn leaves_codex_as_it_is_with_the_switch_off() {
        assert_eq!(
            terminal_launch(
                TerminalCommand::Codex,
                &strings(&["exec"]),
                &bedrock(),
                false
            ),
            TerminalLaunch {
                env: bedrock(),
                args: strings(&["exec"]),
                check_login: false
            }
        );
    }

    #[test]
    fn takes_only_the_subscription_login() {
        let claude =
            |status: &str| signed_in_to_subscription(TerminalCommand::Claude, status, "", Some(0));
        assert!(claude(
            r#"{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}"#
        ));
        assert!(!claude(r#"{"loggedIn":true,"authMethod":"api_key"}"#));
        assert!(!claude(r#"{"loggedIn":false}"#));
        assert!(!signed_in_to_subscription(
            TerminalCommand::Claude,
            "boom",
            "",
            Some(1)
        ));
        assert!(signed_in_to_subscription(
            TerminalCommand::Codex,
            "",
            "Logged in using ChatGPT\n",
            Some(0)
        ));
        assert!(!signed_in_to_subscription(
            TerminalCommand::Codex,
            "",
            "Logged in using an API key - sk-…\n",
            Some(0)
        ));
    }

    /// A database file holding only `runtime_state` with these rows.
    fn database(rows: &[(&str, &str)]) -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix("prism-switch-")
            .tempdir()
            .unwrap();
        let file = dir.path().join("agent.db").to_string_lossy().into_owned();
        let mut conn = crate::db::open_connection(&file).unwrap();
        conn.batch_execute(
            "CREATE TABLE runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER)",
        )
        .unwrap();
        for (key, value) in rows {
            diesel::sql_query("INSERT INTO runtime_state VALUES (?, ?, 0)")
                .bind::<Text, _>(*key)
                .bind::<Text, _>(*value)
                .execute(&mut conn)
                .unwrap();
        }
        (dir, format!("file:{file}"))
    }

    #[test]
    fn reads_the_switch_the_runtime_stored_without_writing() {
        let (_dir, url) = database(&[("codingAgentSubscription:codex", "on")]);
        let _writer = crate::db::open_connection(url.strip_prefix("file:").unwrap()).unwrap();
        assert!(read_subscription_switch(Some(&url), CodingAgentName::Codex).unwrap());
        assert!(!read_subscription_switch(Some(&url), CodingAgentName::ClaudeCode).unwrap());
    }

    #[test]
    fn fails_for_a_database_that_is_not_there_and_never_creates_one() {
        let missing = std::env::temp_dir().join(format!("prism-missing-{}.db", std::process::id()));
        let url = format!("file:{}", missing.display());
        assert!(read_subscription_switch(Some(&url), CodingAgentName::Codex).is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn is_held_on_by_the_environment_without_reading_the_database() {
        assert!(
            terminal_uses_subscription(
                &env_of(&[("CLAUDE_CODE_SUBSCRIPTION", "true")]),
                CodingAgentName::ClaudeCode
            )
            .unwrap()
        );
    }
}
