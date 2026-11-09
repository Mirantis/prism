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
use anyhow::Context;
use base64::Engine;
use serde_json::json;

use crate::lib::coding_agents::claude_code::authenticated_home::{
    SavedLogin, read_auth_status, subscription_environment as claude_subscription_environment,
};
use crate::lib::coding_agents::cli_probe::probe_cli;
use crate::lib::coding_agents::codex::credentials::subscription_environment as codex_subscription_environment;
use crate::lib::execution_environments::execution_environment::{ExecutionEnvironment, ProcessEnv};
use crate::lib::log_redaction::err_json;
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
    let paths = environment.paths();
    match agent {
        CodingAgentName::ClaudeCode => paths.claude_home,
        CodingAgentName::Codex => paths.codex_home,
    }
}

/// The environment the CLI runs with: the base environment without the
/// variables that outrank a subscription, and the home set.
fn cli_environment(environment: &dyn ExecutionEnvironment, agent: CodingAgentName) -> ProcessEnv {
    let base = environment.base_env();
    let home = home_of(environment, agent);
    let (mut env, key) = match agent {
        CodingAgentName::ClaudeCode => {
            (claude_subscription_environment(&base), "CLAUDE_CONFIG_DIR")
        }
        CodingAgentName::Codex => (codex_subscription_environment(&base), "CODEX_HOME"),
    };
    env.insert(key.to_string(), home);
    env
}

/// Each coding agent's answer to whether its CLI runs here, asked once.
static INSTALLED: LazyLock<
    parking_lot::Mutex<HashMap<CodingAgentName, Arc<tokio::sync::OnceCell<bool>>>>,
> = LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));

/// Whether the coding agent's CLI runs here (`<cli> --version` exits 0). Asked
/// once: the image settles it. A probe that fails answers false.
pub async fn cli_installed(environment: &dyn ExecutionEnvironment, agent: CodingAgentName) -> bool {
    let answer = INSTALLED.lock().entry(agent).or_default().clone();
    *answer
        .get_or_init(|| async {
            let args = vec!["--version".to_string()];
            probe_cli(
                environment,
                command(agent),
                &args,
                environment.base_env(),
                None,
            )
            .await
            .is_ok_and(|run| run.exit_code == Some(0))
        })
        .await
}

/// The coding agents whose CLI runs here, in `CODING_AGENTS` order.
pub async fn installed_clis(environment: &dyn ExecutionEnvironment) -> Vec<CodingAgentName> {
    let runs = futures::future::join_all(
        CODING_AGENTS
            .iter()
            .map(|agent| cli_installed(environment, *agent)),
    )
    .await;
    CODING_AGENTS
        .into_iter()
        .zip(runs)
        .filter_map(|(agent, installed)| installed.then_some(agent))
        .collect()
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
    let read = match agent {
        CodingAgentName::ClaudeCode => read_claude_account(environment).await,
        CodingAgentName::Codex => read_codex_account(environment).await,
    };
    match read {
        Ok(account) => account,
        Err(err) => {
            log_warn!(
                json!({ "err": err_json(&err), "agent": agent }),
                "[CodingAgents] Could not read the signed-in account"
            );
            None
        }
    }
}

async fn read_claude_account(
    environment: &dyn ExecutionEnvironment,
) -> anyhow::Result<Option<SubscriptionAccount>> {
    let reading = read_auth_status(
        environment,
        &environment.base_env(),
        &environment.paths().claude_home,
        None,
    )
    .await?;
    if reading.login != SavedLogin::Subscription {
        return Ok(None);
    }
    let plan_type = match reading.status.subscription_type {
        Some(Some(plan)) => Value::String(plan),
        _ => Value::Null,
    };
    Ok(Some(SubscriptionAccount {
        plan: plan_name("Claude", &plan_type),
        email: reading.status.email.unwrap_or_default(),
    }))
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
    let path = format!("{}/auth.json", environment.paths().codex_home);
    let Ok(text) = environment.files().read_text(&path, Some(64 * 1024)).await else {
        return Ok(None);
    };
    let Ok(saved) = serde_json::from_str::<Value>(&text) else {
        return Ok(None);
    };
    let id_token = saved
        .get("tokens")
        .filter(|tokens| !tokens.is_null())
        .and_then(|tokens| tokens.get("id_token"))
        .filter(|token| !token.is_null());
    let Some(id_token) = id_token else {
        return Ok(None);
    };
    let id_token = id_token
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("saved.tokens.id_token.split is not a function"))?;
    let Some(payload) = id_token.split('.').nth(1).filter(|part| !part.is_empty()) else {
        return Ok(None);
    };
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .context("the id token's claims are not base64url")?;
    let claims: CodexIdClaims = serde_json::from_slice(&decoded)?;
    let plan_type = claims
        .auth
        .map(|auth| auth.chatgpt_plan_type)
        .unwrap_or(Value::Null);
    Ok(Some(SubscriptionAccount {
        plan: plan_name("ChatGPT", &plan_type),
        email: claims.email.unwrap_or_default(),
    }))
}

/// Removes the login saved in the home. Fails ("<cli> sign-out exited with
/// <code>") when the CLI fails to and the home still holds an account.
pub async fn sign_out_cli(
    environment: &dyn ExecutionEnvironment,
    agent: CodingAgentName,
) -> anyhow::Result<()> {
    let args: Vec<String> = match agent {
        CodingAgentName::ClaudeCode => vec!["auth".into(), "logout".into()],
        CodingAgentName::Codex => vec![
            "logout".into(),
            "-c".into(),
            "cli_auth_credentials_store=\"file\"".into(),
        ],
    };
    let run = probe_cli(
        environment,
        command(agent),
        &args,
        cli_environment(environment, agent),
        None,
    )
    .await?;
    if run.exit_code != Some(0) && read_account(environment, agent).await.is_some() {
        let code = run
            .exit_code
            .map_or_else(|| "null".to_string(), |code| code.to_string());
        anyhow::bail!("{} sign-out exited with {code}", command(agent));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::coding_agents::testing::{
        DIR_STAT, FakeChild, FakeEnvironment, FakeFiles, fake_paths,
    };

    #[test]
    fn names_the_plan_the_login_reports() {
        assert_eq!(plan_name("Claude", &json!("max")), "Claude Max");
        assert_eq!(plan_name("ChatGPT", &json!("plus")), "ChatGPT Plus");
    }

    #[test]
    fn assumes_no_plan_when_the_login_names_none() {
        assert_eq!(plan_name("ChatGPT", &Value::Null), "ChatGPT plan");
        assert_eq!(plan_name("ChatGPT", &json!(" ")), "ChatGPT plan");
    }

    /// An environment whose `claude auth status --json` prints `status`.
    fn printing(status: Value) -> FakeEnvironment {
        FakeEnvironment {
            files: FakeFiles {
                stat: Some(Arc::new(|_| Ok(DIR_STAT))),
                ..Default::default()
            },
            ..FakeEnvironment::with_run_program(move |_, _, _| {
                let child = FakeChild::new();
                child.emit_line(&status.to_string());
                child.finish(Some(0));
                child.process()
            })
        }
    }

    #[tokio::test]
    async fn names_the_claude_subscription_the_saved_login_reports() {
        let status = json!({ "loggedIn": true, "authMethod": "claude.ai", "email": "user@example.com", "subscriptionType": "max" });
        assert_eq!(
            read_account(&printing(status), CodingAgentName::ClaudeCode).await,
            Some(SubscriptionAccount {
                plan: "Claude Max".into(),
                email: "user@example.com".into()
            })
        );
    }

    #[tokio::test]
    async fn names_none_for_a_saved_claude_login_that_is_not_a_subscription() {
        let status = json!({ "loggedIn": true, "authMethod": "api_key" });
        assert_eq!(
            read_account(&printing(status), CodingAgentName::ClaudeCode).await,
            None
        );
    }

    #[tokio::test]
    async fn names_the_chatgpt_plan_in_the_saved_id_token() {
        let home = tempfile::tempdir().unwrap();
        let claims = json!({ "email": "user@example.com", "https://api.openai.com/auth": { "chatgpt_plan_type": "plus" } });
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string());
        std::fs::write(
            home.path().join("auth.json"),
            json!({ "tokens": { "id_token": format!("header.{payload}.signature") } }).to_string(),
        )
        .unwrap();
        let mut paths = fake_paths("/workspace");
        paths.codex_home = home.path().to_string_lossy().into_owned();
        let environment = FakeEnvironment {
            paths,
            files: FakeFiles::local(),
            ..Default::default()
        };
        assert_eq!(
            read_account(&environment, CodingAgentName::Codex).await,
            Some(SubscriptionAccount {
                plan: "ChatGPT Plus".into(),
                email: "user@example.com".into()
            })
        );
        std::fs::write(home.path().join("auth.json"), "{}").unwrap();
        assert_eq!(
            read_account(&environment, CodingAgentName::Codex).await,
            None
        );
    }
}
