//! One adapter instance per available agent, shared by startup and task execution.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;

use super::coding_agent::CodingAgent;
use crate::config::CodingAgentName;

static INSTANCES: LazyLock<Mutex<HashMap<CodingAgentName, Arc<dyn CodingAgent>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The adapter for `name` (`config.coding_agent` when `None`). Fails for an agent
/// that is not available:
/// `Coding agent "<name>" is unavailable. Available agents: <list, or none>.
/// Configure its credentials or select an available agent.`
pub fn get_coding_agent(name: Option<CodingAgentName>) -> anyhow::Result<Arc<dyn CodingAgent>> {
    todo!()
}
