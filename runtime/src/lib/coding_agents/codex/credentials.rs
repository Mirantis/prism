//! How a Codex task authenticates, and the login saved in Codex's home.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::lib::coding_agents::bedrock_credentials::has_bedrock_credentials;
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};
use crate::lib::execution_environments::workspace::path_resolve;

/// Kept out of a run on the subscription: the variables Codex 0.163 takes a
/// credential from, each of which outranks a saved login, and the deployment's
/// OpenAI-compatible gateway, which must not receive the login's token.
pub const LEAVES_THE_SUBSCRIPTION: &[&str] = &[
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_BASE_URL",
];

/// How a Codex task authenticates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodexAuthMethod {
    Api,
    Saved,
    Bedrock,
    Subscription,
}

impl CodexAuthMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            CodexAuthMethod::Api => "api",
            CodexAuthMethod::Saved => "saved",
            CodexAuthMethod::Bedrock => "bedrock",
            CodexAuthMethod::Subscription => "subscription",
        }
    }
}

/// The login saved in the CLI's home: a ChatGPT sign-in, another saved login, or none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SavedCodexLogin {
    Chatgpt,
    Other,
    None,
}

impl SavedCodexLogin {
    pub fn as_str(self) -> &'static str {
        match self {
            SavedCodexLogin::Chatgpt => "chatgpt",
            SavedCodexLogin::Other => "other",
            SavedCodexLogin::None => "none",
        }
    }
}

/// `CODEX_HOME`, else `<data dir>/.codex`, resolved. `data_dir` defaults to
/// `resolve_data_dir()`.
pub fn resolve_codex_home(env: &ProcessEnv, data_dir: Option<&str>) -> String {
    match data_dir {
        Some(dir) => resolve_codex_home_in(env, dir),
        None => resolve_codex_home_in(env, &crate::lib::data_dir::resolve_data_dir()),
    }
}

/// `resolve_codex_home` with the data dir given.
pub fn resolve_codex_home_in(env: &ProcessEnv, data_dir: &str) -> String {
    match env.get("CODEX_HOME").filter(|v| !v.is_empty()) {
        Some(home) => path_resolve(home),
        None => path_resolve(&format!("{data_dir}/.codex")),
    }
}

/// Whether the CLI has a saved login in its home (`<codex home>/auth.json`).
///
/// Asked of the execution environment, because that is where the home is.
/// Never fails: no answer means no saved login.
pub async fn has_saved_codex_login(environment: &dyn ExecutionEnvironment) -> bool {
    todo!()
}

/// `CODEX_API_KEY`, else `OPENAI_API_KEY`.
pub fn codex_api_key(env: &ProcessEnv) -> Option<String> {
    env.get("CODEX_API_KEY")
        .filter(|v| !v.is_empty())
        .or_else(|| env.get("OPENAI_API_KEY"))
        .cloned()
}

/// `saved_login` is the boot-time answer from `has_saved_codex_login`: reading the
/// home costs a round trip to the execution environment, and this is asked
/// while building a task's argv, where there is nothing to await on. Never
/// `Subscription`.
pub fn codex_auth_method(env: &ProcessEnv, saved_login: bool) -> Option<CodexAuthMethod> {
    if codex_api_key(env).is_some_and(|key| !key.is_empty()) {
        return Some(CodexAuthMethod::Api);
    }
    // Codex validates the saved credentials and refreshes its own login tokens.
    if saved_login {
        return Some(CodexAuthMethod::Saved);
    }
    if has_bedrock_credentials(env) {
        return Some(CodexAuthMethod::Bedrock);
    }
    None
}

/// `env` without the variables that outrank the home's saved login or move its endpoint.
pub fn subscription_environment(env: &ProcessEnv) -> ProcessEnv {
    env.iter()
        .filter(|(key, _)| !LEAVES_THE_SUBSCRIPTION.contains(&key.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Ask `codex login status` about the home's saved login, in the environment
/// where the binary and its home are, from the same credential store a task
/// reads.
///
/// Fails when the CLI gives no answer. Only the status line's form is read:
/// for an API key the line shows part of the key, so none of it reaches a
/// message.
pub async fn read_codex_login(
    environment: &dyn ExecutionEnvironment,
    env: &ProcessEnv,
    codex_home: &str,
    signal: Option<CancellationToken>,
) -> anyhow::Result<SavedCodexLogin> {
    todo!()
}

pub const LOGIN_STATUS_ARGS: &[&str] = &[
    "login",
    "status",
    "-c",
    "cli_auth_credentials_store=\"file\"",
];

static CHATGPT_LOGIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?mR)^Logged in using ChatGPT$").unwrap());
static OTHER_LOGIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?mR)^Logged in using ").unwrap());
static NOT_LOGGED_IN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?mR)^Not logged in$").unwrap());

/// The saved login `codex login status` printed. Fails when it printed no status.
pub fn codex_login_from_status(
    output: &str,
    exit_code: Option<i32>,
) -> anyhow::Result<SavedCodexLogin> {
    // Codex 0.163 writes the status to stderr, and exits 1 when nobody is signed in.
    if CHATGPT_LOGIN.is_match(output) {
        return Ok(SavedCodexLogin::Chatgpt);
    }
    if OTHER_LOGIN.is_match(output) {
        return Ok(SavedCodexLogin::Other);
    }
    if NOT_LOGGED_IN.is_match(output) {
        return Ok(SavedCodexLogin::None);
    }
    let code = exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "null".to_string());
    anyhow::bail!("codex login status exited with {code} and no status")
}

/// The config a Codex run on the subscription takes: OpenAI's own provider at
/// ChatGPT's own endpoints, so the home's `config.toml` can't move it to one
/// that bills the deployment or receives the login's token, and the ChatGPT
/// login saved in the home's file store, and no other. Codex takes an empty
/// `openai_base_url` as unset, which for a ChatGPT login is ChatGPT's endpoint.
pub const SUBSCRIPTION_CONFIG_ARGS: &[&str] = &[
    "-c",
    "model_provider=\"openai\"",
    "-c",
    "openai_base_url=\"\"",
    "-c",
    "chatgpt_base_url=\"https://chatgpt.com/backend-api/\"",
    "-c",
    "forced_login_method=\"chatgpt\"",
    "-c",
    "cli_auth_credentials_store=\"file\"",
];
