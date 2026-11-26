//! Which coding agents this deployment can actually run.
//!
//! Each adapter answers for itself against the execution environment, so the
//! question is "does the agent have credentials *there*" rather than on
//! whichever machine the runtime happens to be. That makes the answer async,
//! which is why it is a boot step rather than a config constant: the config is
//! evaluated at start, long before a second environment could be asked
//! anything.
//!
//! Memoized, so the boot call and the first turn's `collect_tools()` share one
//! probe and every later turn is free. That also settles the tool descriptions
//! before the first tools block is built, which the prompt cache needs.

use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::OnceCell;

use super::agy::agy_agent::create_agy_agent;
use super::claude_code::claude_code_agent::create_claude_code_agent;
use super::codex::codex_agent::create_codex_agent;
use super::coding_agent::CodingAgent;
use crate::config::{CODING_AGENTS, CONFIG, CodingAgentName};
use crate::lib::execution_environments::get_execution_environment::get_execution_environment;
use crate::lib::log_redaction::err_json;
use crate::{log_info, log_warn};

/// Every adapter, whether or not it is available — the availability check is
/// what this module is about, so `get_coding_agent`'s would be circular.
fn factory(name: CodingAgentName) -> Arc<dyn CodingAgent> {
    match name {
        CodingAgentName::ClaudeCode => create_claude_code_agent(None),
        CodingAgentName::Codex => create_codex_agent(None),
        CodingAgentName::Agy => create_agy_agent(None),
    }
}

static PROBE: LazyLock<Mutex<Arc<OnceCell<()>>>> =
    LazyLock::new(|| Mutex::new(Arc::new(OnceCell::new())));

/// Fill `config.available_coding_agents` and `config.coding_agent`, once per
/// process. Every later caller awaits the same settled probe. A failed probe
/// leaves no agent available rather than a wrong one (logged as
/// `[CodingAgents] credential detection failed; none available`).
pub async fn ensure_coding_agents_detected() {
    let probe = PROBE.lock().clone();
    probe
        .get_or_init(|| async {
            if let Err(err) = detect().await {
                // A failed probe leaves no agent available rather than a wrong
                // one: the `coding_agent` tool then says so, which beats
                // launching a binary that cannot authenticate.
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[CodingAgents] credential detection failed; none available"
                );
            }
        })
        .await;
}

/// Ask each adapter with the execution environment's base env, then choose the
/// default agent unless the operator named one (`[Startup] coding agents detected`).
async fn detect() -> anyhow::Result<()> {
    let mut available = Vec::new();
    for name in CODING_AGENTS {
        // The env the task runs with, since the probe runs in the same
        // environment and a host `PATH` or `HOME` would decide the answer there.
        if factory(name)
            .is_available(&get_execution_environment().base_env())
            .await?
        {
            available.push(name);
        }
    }
    CONFIG.set_available_coding_agents(available.clone());
    // An explicit CODING_AGENT is the operator's choice and stands even when its
    // credentials are missing, so the failure names the agent they asked for.
    if CONFIG.configured_coding_agent.is_none() {
        CONFIG.set_coding_agent(default_agent(&available));
    }
    log_info!(
        json!({ "available": available, "effective": CONFIG.coding_agent() }),
        "[Startup] coding agents detected"
    );
    Ok(())
}

/// Claude Code, then Codex, then Agy, falling back to Claude Code when none are available.
fn default_agent(available: &[CodingAgentName]) -> CodingAgentName {
    for candidate in CODING_AGENTS {
        if available.contains(&candidate) {
            return candidate;
        }
    }
    CodingAgentName::ClaudeCode
}

/// Ask again after a sign-in, which can make an agent available. A changed
/// answer changes the tool descriptions, so the next turn writes the prompt
/// cache's prefix once more.
pub async fn redetect_coding_agents() {
    *PROBE.lock() = Arc::new(OnceCell::new());
    ensure_coding_agents_detected().await
}

/// Test-only: forget the probe so the next call runs it again.
pub fn reset_coding_agent_detection_for_tests() {
    *PROBE.lock() = Arc::new(OnceCell::new());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_claude_code_whenever_it_is_available() {
        use CodingAgentName::*;
        assert_eq!(default_agent(&[]), ClaudeCode);
        assert_eq!(default_agent(&[ClaudeCode]), ClaudeCode);
        assert_eq!(default_agent(&[ClaudeCode, Codex]), ClaudeCode);
        assert_eq!(default_agent(&[ClaudeCode, Agy]), ClaudeCode);
        assert_eq!(default_agent(&[Codex]), Codex);
        assert_eq!(default_agent(&[Codex, Agy]), Codex);
        assert_eq!(default_agent(&[Agy]), Agy);
    }
}
