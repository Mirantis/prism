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
use tokio::sync::OnceCell;

use super::claude_code::claude_code_agent::create_claude_code_agent;
use super::codex::codex_agent::create_codex_agent;
use super::coding_agent::CodingAgent;
use crate::config::CodingAgentName;

/// Every adapter, whether or not it is available — the availability check is
/// what this module is about, so `get_coding_agent`'s would be circular.
fn factory(name: CodingAgentName) -> Arc<dyn CodingAgent> {
    match name {
        CodingAgentName::ClaudeCode => create_claude_code_agent(None),
        CodingAgentName::Codex => create_codex_agent(None),
    }
}

static PROBE: LazyLock<Mutex<Arc<OnceCell<()>>>> =
    LazyLock::new(|| Mutex::new(Arc::new(OnceCell::new())));

/// Fill `config.available_coding_agents` and `config.coding_agent`, once per
/// process. Every later caller awaits the same settled probe. A failed probe
/// leaves no agent available rather than a wrong one (logged as
/// `[CodingAgents] credential detection failed; none available`).
pub async fn ensure_coding_agents_detected() {
    todo!()
}

/// Ask each adapter with the execution environment's base env, then choose the
/// default agent unless the operator named one (`[Startup] coding agents detected`).
async fn detect() -> anyhow::Result<()> {
    todo!()
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
