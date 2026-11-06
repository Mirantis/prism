//! `claude` and `codex` in the desktop's terminal follow the same subscription
//! switch as tasks: on it, the saved login and nothing that outranks it, and a
//! refusal when nobody is signed in; off it, the deployment's models.
//!
//! Reads nothing of the configuration, so `coding-agent-exec` uses it without
//! starting the runtime.

use crate::config::CodingAgentName;
use crate::lib::execution_environments::execution_environment::ProcessEnv;

use super::claude_code::authenticated_home::{
    AUTH_STATUS_ARGS, SUBSCRIPTION_SETTINGS, SavedLogin, saved_login_from_status,
};
use super::claude_code::environment::claude_code_launch_environment;
use super::codex::credentials::{
    LOGIN_STATUS_ARGS, SUBSCRIPTION_CONFIG_ARGS, SavedCodexLogin, codex_login_from_status,
    subscription_environment as codex_subscription_environment,
};

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

pub fn is_terminal_command(value: Option<&str>) -> bool {
    TerminalCommand::parse(value).is_some()
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
    todo!()
}

/// The switch for the terminal: held on by the environment, or as stored.
pub fn terminal_uses_subscription(
    env: &ProcessEnv,
    agent: CodingAgentName,
) -> anyhow::Result<bool> {
    todo!()
}
