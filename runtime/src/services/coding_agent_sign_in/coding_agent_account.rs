//! The subscription signed in to a coding agent's CLI home, as the person is
//! shown it, and signing it out.
//!
//! The email is read for the person's own screen only: it never goes into a
//! message, a log or telemetry.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::{CODING_AGENTS, CodingAgentName};
use crate::lib::coding_agents::claude_code::authenticated_home::{
    read_auth_status, subscription_environment as claude_subscription_environment,
};
use crate::lib::coding_agents::cli_probe::probe_cli;
use crate::lib::coding_agents::codex::credentials::subscription_environment as codex_subscription_environment;
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};
use crate::log_warn;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionAccount {
    /// Ready to show, e.g. "Claude Max" or "ChatGPT Plus".
    pub plan: String,
    pub email: String,
}

/// The CLI each coding agent runs as.
fn command(agent: CodingAgentName) -> &'static str {
    match agent {
        CodingAgentName::ClaudeCode => "claude",
        CodingAgentName::Codex => "codex",
    }
}

/// The CLI's home in `environment`: its `claude_home` or `codex_home` path.
pub fn home_of(environment: &dyn ExecutionEnvironment, agent: CodingAgentName) -> String {
    todo!()
}

/// The environment the CLI runs with: the base environment without the
/// variables that outrank a subscription, and the home set.
fn cli_environment(environment: &dyn ExecutionEnvironment, agent: CodingAgentName) -> ProcessEnv {
    todo!()
}

/// Each coding agent's answer to whether its CLI runs here, asked once.
static INSTALLED: LazyLock<
    parking_lot::Mutex<HashMap<CodingAgentName, Arc<tokio::sync::OnceCell<bool>>>>,
> = LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));

/// Whether the coding agent's CLI runs here (`<cli> --version` exits 0). Asked
/// once: the image settles it. A probe that fails answers false.
pub async fn cli_installed(environment: &dyn ExecutionEnvironment, agent: CodingAgentName) -> bool {
    todo!()
}

/// The coding agents whose CLI runs here, in `CODING_AGENTS` order.
pub async fn installed_clis(environment: &dyn ExecutionEnvironment) -> Vec<CodingAgentName> {
    todo!()
}

/// The plan the login names, "max" as "Claude Max". A login that names none is
/// "ChatGPT plan": no plan is assumed.
pub fn plan_name(prefix: &str, plan_type: &Value) -> String {
    let named = match plan_type {
        Value::String(text) => text.trim(),
        _ => "",
    };
    let mut chars = named.chars();
    match chars.next() {
        Some(first) => format!("{prefix} {}{}", first.to_uppercase(), chars.as_str()),
        None => format!("{prefix} plan"),
    }
}

/// The subscription signed in to the home, or `None` when none is. Never fails:
/// a read that fails is logged ("[CodingAgents] Could not read the signed-in
/// account") and reads as `None`.
pub async fn read_account(
    environment: &dyn ExecutionEnvironment,
    agent: CodingAgentName,
) -> Option<SubscriptionAccount> {
    todo!()
}

async fn read_claude_account(
    environment: &dyn ExecutionEnvironment,
) -> anyhow::Result<Option<SubscriptionAccount>> {
    todo!()
}

/// The claims of Codex's saved ChatGPT login that name the account and its plan.
#[derive(Debug, Clone, Default, Deserialize)]
struct CodexIdClaims {
    email: Option<String>,
    #[serde(rename = "https://api.openai.com/auth")]
    auth: Option<CodexAuthClaims>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct CodexAuthClaims {
    #[serde(default)]
    chatgpt_plan_type: Value,
}

/// The ChatGPT login in `<codex home>/auth.json` (read up to 64 KiB): the email
/// and plan from its id token's claims. `None` when the file is missing or
/// unreadable, or holds no id token.
async fn read_codex_account(
    environment: &dyn ExecutionEnvironment,
) -> anyhow::Result<Option<SubscriptionAccount>> {
    todo!()
}

/// Removes the login saved in the home. Fails ("<cli> sign-out exited with
/// <code>") when the CLI fails to and the home still holds an account.
pub async fn sign_out_cli(
    environment: &dyn ExecutionEnvironment,
    agent: CodingAgentName,
) -> anyhow::Result<()> {
    todo!()
}
