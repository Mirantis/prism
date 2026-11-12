//! Whether a coding agent's tasks run on the subscription signed in to its
//! CLI's home rather than the deployment's models.
//!
//! A sign-in from Coding agents turns it on and a sign-out turns it off; a
//! saved login alone changes nothing. `CLAUDE_CODE_SUBSCRIPTION` and
//! `CODEX_SUBSCRIPTION` hold it on for a deployment that signs in by hand.
//!
//! Stored in `runtime_state` and held here once loaded at boot, because a
//! task's argv is built synchronously.

use std::collections::HashSet;
use std::sync::LazyLock;

use parking_lot::Mutex;
use serde_json::json;

use crate::config::{CODING_AGENTS, CONFIG, CodingAgentName};
use crate::lib::log_redaction::err_json;
use crate::log_warn;
use crate::services::runtime_state_service::RUNTIME_STATE_SERVICE;

pub use super::subscription::subscription_key;

/// The agents signed in from Coding agents.
static SIGNED_IN: LazyLock<Mutex<HashSet<CodingAgentName>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Whether the deployment's environment holds the subscription on
/// (`config.claude_code_subscription` / `config.codex_subscription`).
pub fn subscription_forced(agent: CodingAgentName) -> bool {
    match agent {
        CodingAgentName::ClaudeCode => CONFIG.claude_code_subscription,
        CodingAgentName::Codex => CONFIG.codex_subscription,
    }
}

pub fn uses_subscription(agent: CodingAgentName) -> bool {
    subscription_forced(agent) || SIGNED_IN.lock().contains(&agent)
}

/// Read at boot. An unreadable switch stays off, so tasks run on the deployment's
/// models (`[CodingAgents] Could not read the subscription switch`).
pub async fn load_subscription_switches() {
    for agent in CODING_AGENTS {
        match RUNTIME_STATE_SERVICE.get(&subscription_key(agent)).await {
            Ok(value) => {
                if value.as_deref() == Some("on") {
                    SIGNED_IN.lock().insert(agent);
                }
            }
            Err(err) => {
                log_warn!(
                    json!({ "err": err_json(&err), "agent": agent }),
                    "[CodingAgents] Could not read the subscription switch"
                );
            }
        }
    }
}

/// Store the switch (`on`, or the key removed) and hold it in memory.
pub async fn set_subscription(agent: CodingAgentName, on: bool) -> anyhow::Result<()> {
    if on {
        RUNTIME_STATE_SERVICE
            .set(&subscription_key(agent), "on")
            .await?;
        SIGNED_IN.lock().insert(agent);
    } else {
        RUNTIME_STATE_SERVICE
            .delete(&subscription_key(agent))
            .await?;
        SIGNED_IN.lock().remove(&agent);
    }
    Ok(())
}

/// Test-only: hold the switch in memory without storing it, or forget it.
#[cfg(test)]
pub(crate) fn set_subscription_in_memory_for_tests(agent: CodingAgentName, on: bool) {
    if on {
        SIGNED_IN.lock().insert(agent);
    } else {
        SIGNED_IN.lock().remove(&agent);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forget() {
        SIGNED_IN.lock().clear();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn keeps_a_sign_in_across_a_restart() {
        let _db = crate::db::testing::test_db();
        forget();
        set_subscription(CodingAgentName::Codex, true)
            .await
            .unwrap();
        assert!(uses_subscription(CodingAgentName::Codex));

        forget();
        assert!(!uses_subscription(CodingAgentName::Codex));
        load_subscription_switches().await;
        assert!(uses_subscription(CodingAgentName::Codex));
        assert!(!uses_subscription(CodingAgentName::ClaudeCode));
        forget();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn turns_off_on_sign_out() {
        let _db = crate::db::testing::test_db();
        forget();
        set_subscription(CodingAgentName::ClaudeCode, true)
            .await
            .unwrap();
        set_subscription(CodingAgentName::ClaudeCode, false)
            .await
            .unwrap();
        assert!(!uses_subscription(CodingAgentName::ClaudeCode));
        for agent in CODING_AGENTS {
            assert_eq!(
                RUNTIME_STATE_SERVICE
                    .get(&subscription_key(agent))
                    .await
                    .unwrap(),
                None
            );
        }
    }

    #[test]
    fn the_test_deployment_holds_no_subscription_on() {
        assert!(!subscription_forced(CodingAgentName::ClaudeCode));
        assert!(!subscription_forced(CodingAgentName::Codex));
    }
}
