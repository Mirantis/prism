//! One adapter instance per available agent, shared by startup and task execution.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;

use super::agy::agy_agent::create_agy_agent;
use super::claude_code::claude_code_agent::create_claude_code_agent;
use super::codex::codex_agent::create_codex_agent;
use super::coding_agent::CodingAgent;
use crate::config::{CONFIG, CodingAgentName};

/// A new adapter for `name`, whether or not it is available.
pub(super) fn factory(name: CodingAgentName) -> Arc<dyn CodingAgent> {
    match name {
        CodingAgentName::ClaudeCode => create_claude_code_agent(None),
        CodingAgentName::Codex => create_codex_agent(None),
        CodingAgentName::Agy => create_agy_agent(None),
    }
}

static INSTANCES: LazyLock<Mutex<HashMap<CodingAgentName, Arc<dyn CodingAgent>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The adapter for `name` (`config.coding_agent` when `None`). Fails for an agent
/// that is not available:
/// `Coding agent "<name>" is unavailable. Available agents: <list, or none>.
/// Configure its credentials or select an available agent.`
pub fn get_coding_agent(name: Option<CodingAgentName>) -> anyhow::Result<Arc<dyn CodingAgent>> {
    let name = name.unwrap_or_else(|| CONFIG.coding_agent());
    let available = CONFIG.available_coding_agents();
    if !available.contains(&name) {
        let list = available
            .iter()
            .map(|agent| agent.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        anyhow::bail!(
            "Coding agent \"{name}\" is unavailable. Available agents: {}. Configure its credentials or select an available agent.",
            if list.is_empty() { "none" } else { &list }
        );
    }
    Ok(INSTANCES
        .lock()
        .entry(name)
        .or_insert_with(|| factory(name))
        .clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs `check` with these agents available and `default` as the default,
    /// then puts the configuration back.
    fn with_agents(available: &[CodingAgentName], default: CodingAgentName, check: impl FnOnce()) {
        let (previous_available, previous_default) =
            (CONFIG.available_coding_agents(), CONFIG.coding_agent());
        CONFIG.set_available_coding_agents(available.to_vec());
        CONFIG.set_coding_agent(default);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(check));
        CONFIG.set_available_coding_agents(previous_available);
        CONFIG.set_coding_agent(previous_default);
        if let Err(panic) = outcome {
            std::panic::resume_unwind(panic);
        }
    }

    const ALL: [CodingAgentName; 3] = [
        CodingAgentName::ClaudeCode,
        CodingAgentName::Codex,
        CodingAgentName::Agy,
    ];

    #[test]
    #[serial_test::serial]
    fn defaults_to_the_configured_agent() {
        for (id, name) in [
            (CodingAgentName::ClaudeCode, "Claude Code"),
            (CodingAgentName::Codex, "Codex"),
            (CodingAgentName::Agy, "Antigravity CLI"),
        ] {
            with_agents(&ALL, id, || {
                let agent = get_coding_agent(None).unwrap();
                assert_eq!(agent.id(), id);
                assert_eq!(agent.display_name(), name);
            });
        }
    }

    #[test]
    #[serial_test::serial]
    fn reuses_one_instance_per_available_agent() {
        with_agents(&ALL, CodingAgentName::ClaudeCode, || {
            let codex = || get_coding_agent(Some(CodingAgentName::Codex)).unwrap();
            let claude = || get_coding_agent(Some(CodingAgentName::ClaudeCode)).unwrap();
            let agy = || get_coding_agent(Some(CodingAgentName::Agy)).unwrap();
            assert!(Arc::ptr_eq(&codex(), &codex()));
            assert!(Arc::ptr_eq(&claude(), &claude()));
            assert!(Arc::ptr_eq(&agy(), &agy()));
            assert!(!Arc::ptr_eq(&codex(), &claude()));
            assert!(!Arc::ptr_eq(&agy(), &claude()));
        });
    }

    #[test]
    #[serial_test::serial]
    fn selects_an_available_agent_instead_of_the_configured_default() {
        with_agents(&ALL, CodingAgentName::ClaudeCode, || {
            assert_eq!(
                get_coding_agent(Some(CodingAgentName::Codex)).unwrap().id(),
                CodingAgentName::Codex
            );
            assert_eq!(
                get_coding_agent(Some(CodingAgentName::Agy)).unwrap().id(),
                CodingAgentName::Agy
            );
        });
    }

    #[test]
    #[serial_test::serial]
    fn rejects_an_unavailable_agent_before_launch() {
        with_agents(
            &[CodingAgentName::ClaudeCode],
            CodingAgentName::ClaudeCode,
            || {
                let err = get_coding_agent(Some(CodingAgentName::Codex))
                    .err()
                    .unwrap()
                    .to_string();
                assert!(err.contains("Available agents: claude-code"));
            },
        );
        with_agents(
            &[CodingAgentName::ClaudeCode],
            CodingAgentName::Codex,
            || {
                let err = get_coding_agent(None).err().unwrap().to_string();
                assert!(err.contains("Coding agent \"codex\" is unavailable"));
            },
        );
        with_agents(&[], CodingAgentName::Codex, || {
            assert_eq!(
                get_coding_agent(None).err().unwrap().to_string(),
                "Coding agent \"codex\" is unavailable. Available agents: none. Configure its credentials or select an available agent."
            );
        });
    }
}
