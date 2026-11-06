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

use crate::config::CodingAgentName;

pub use super::subscription::subscription_key;

/// The agents signed in from Coding agents.
static SIGNED_IN: LazyLock<Mutex<HashSet<CodingAgentName>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Whether the deployment's environment holds the subscription on
/// (`config.claude_code_subscription` / `config.codex_subscription`).
pub fn subscription_forced(agent: CodingAgentName) -> bool {
    todo!()
}

pub fn uses_subscription(agent: CodingAgentName) -> bool {
    subscription_forced(agent) || SIGNED_IN.lock().contains(&agent)
}

/// Read at boot. An unreadable switch stays off, so tasks run on the deployment's
/// models (`[CodingAgents] Could not read the subscription switch`).
pub async fn load_subscription_switches() {
    todo!()
}

/// Store the switch (`on`, or the key removed) and hold it in memory.
pub async fn set_subscription(agent: CodingAgentName, on: bool) -> anyhow::Result<()> {
    todo!()
}
