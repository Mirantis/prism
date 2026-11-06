//! The login saved in the Claude Code CLI's home, and the settings that keep a
//! task on it.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};

/// The variables that outrank a saved login in the CLI's credential order, or
/// send its requests somewhere other than the account's own API.
static OUTRANKS_SAVED_LOGIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$)").unwrap()
});

/// The provider switches and credentials among those variables that Claude Code
/// 2.1.304 reads. `subscription_environment` takes them out of the task's env,
/// but the `env` block of a repository's `.claude/settings.json` or
/// `settings.local.json` sets them again, and `forceLoginMethod` does not refuse
/// a provider or key chosen there. Flag settings outrank both files, so a task's
/// `--settings` restates each one empty. A provider's own base URL needs no
/// entry: nothing reads it while its switch is off.
pub const SAVED_LOGIN_OVERRIDES: &[&str] = &[
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_UNIX_SOCKET",
];

/// The `--settings` of a task on the subscription: the claude.ai login and no
/// other, whatever the repository's own settings say. An empty `apiKeyHelper`
/// replaces one that a repository sets. The base URL is the account's own API
/// rather than empty, because one of the CLI's reads takes an empty value as
/// set (`??`).
pub static SUBSCRIPTION_SETTINGS: LazyLock<String> = LazyLock::new(|| {
    let mut env = Map::new();
    for name in SAVED_LOGIN_OVERRIDES {
        env.insert((*name).to_string(), Value::String(String::new()));
    }
    env.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        Value::String("https://api.anthropic.com".to_string()),
    );
    let settings = json!({
        "forceLoginMethod": "claudeai",
        "apiKeyHelper": "",
        "env": Value::Object(env),
    });
    serde_json::to_string(&settings).unwrap()
});

/// The login saved in the CLI's home: a Claude subscription signed in through
/// claude.ai, another saved login, or none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SavedLogin {
    Subscription,
    Other,
    None,
}

impl SavedLogin {
    pub fn as_str(self) -> &'static str {
        match self {
            SavedLogin::Subscription => "subscription",
            SavedLogin::Other => "other",
            SavedLogin::None => "none",
        }
    }
}

/// The fields of `claude auth status --json` that are read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logged_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<String>,
    /// `null` in the CLI's output is kept as `Some(None)`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "::serde_with::rust::double_option"
    )]
    pub subscription_type: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// A saved login and the status it was read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthStatusReading {
    pub login: SavedLogin,
    pub status: AuthStatus,
}

/// `env` without the variables that outrank the home's saved login.
pub fn subscription_environment(env: &ProcessEnv) -> ProcessEnv {
    env.iter()
        .filter(|(key, _)| !OUTRANKS_SAVED_LOGIN.is_match(key))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Ask `claude auth status` about the home's saved login, in the environment
/// where the binary and its home are. It runs with `subscription_environment`,
/// so the answer is about the home alone.
///
/// Fails when the CLI gives no answer.
pub async fn read_saved_login(
    environment: &dyn ExecutionEnvironment,
    env: &ProcessEnv,
    config_dir: &str,
    signal: Option<tokio_util::sync::CancellationToken>,
) -> anyhow::Result<SavedLogin> {
    Ok(read_auth_status(environment, env, config_dir, signal)
        .await?
        .login)
}

/// `read_saved_login` with the status it was read from. The status names the
/// account, so only the person's own screen shows it: never a message, a log or
/// telemetry. A home that does not exist is `none` without running the CLI.
pub async fn read_auth_status(
    environment: &dyn ExecutionEnvironment,
    env: &ProcessEnv,
    config_dir: &str,
    signal: Option<CancellationToken>,
) -> anyhow::Result<AuthStatusReading> {
    todo!()
}

pub const AUTH_STATUS_ARGS: &[&str] = &["auth", "status", "--json"];

/// The saved login `claude auth status --json` printed. Fails when it printed no status.
pub fn saved_login_from_status(stdout: &str, exit_code: Option<i32>) -> anyhow::Result<SavedLogin> {
    Ok(parse_auth_status(stdout, exit_code)?.login)
}

/// `saved_login_from_status` with the status it was read from. The CLI exits 1
/// with the same JSON when nobody is signed in.
pub fn parse_auth_status(
    stdout: &str,
    exit_code: Option<i32>,
) -> anyhow::Result<AuthStatusReading> {
    todo!()
}
