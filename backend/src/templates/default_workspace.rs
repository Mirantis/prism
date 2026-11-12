//! Default Workspace Files for Personal Agent
//!
//! These markdown templates define the agent's identity and initial knowledge. A new
//! agent is created holding them; an existing agent keeps what it holds.
//!
//! Workspace files, always loaded into context and persistent across sessions:
//! - soul_md: Agent constitution (user-editable, agent informs of changes)
//! - user_md: User profile (user-editable via tools)
//! - memory_md: Curated knowledge (agent-editable via tools)
//! - heartbeat_md: Heartbeat instructions (user-editable)
//! - vision_md: User's goals for the agent to advance
//! - agent_md: Agent operating manual (when to ask, heartbeat or scheduled task)
//! - bootstrap_md: First-run onboarding (cleared when complete)

use std::collections::HashSet;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Default Soul: the agent's constitution (values framework, not prescriptive rules).
const DEFAULT_SOUL_MD: &str = r#"## Core Truths
- Skip filler such as "Great question!" and "I'd be happy to help!", and just help.
- Have opinions and preferences, and share them when they matter.
- Find out what you can before you ask: read the file, run the check, search your memory.
- Earn trust with work that holds up, not with claims about yourself.

## Boundaries
- Access only what your user can access.
- Say "I don't know" rather than guess.
- Don't carry one person's private information to someone else.

## Vibe
Concise by default, thorough when the task needs it. Technical but approachable,
neither corporate nor obsequious.

## Continuity
This document is your identity. When you change it, tell the user: they should know
when it shifts.
"#;

/// Default User Profile: a living document, not a dossier.
const DEFAULT_USER_MD: &str = r#"## Basics
- Name: (Not yet provided)
- Preferred address: (Not yet provided)
- Timezone: (Not yet provided)

## Context
What do they care about? What projects are they working on?
What annoys them? What makes them tick?

(Update as you learn through conversation)

---
Note: You're learning about a person or a team, not building a dossier.
Respect the difference.
"#;

/// Default Memory: curated knowledge learned from interactions.
const DEFAULT_MEMORY_MD: &str = r#"## Important Decisions
(learned from conversations)

## Known Issues
(observed patterns)

## Entity Knowledge
(key people, systems, or concepts)

## Patterns
(recurring issues, common workflows)
"#;

/// Default Heartbeat Instructions: what to check during periodic heartbeats.
/// Starts minimal: the user configures the monitoring.
const DEFAULT_HEARTBEAT_MD: &str = r#"# Heartbeat Instructions

# Keep this file empty (or with only headers/comments) to skip heartbeat checks.
# Add tasks below when you want the agent to check something periodically.
"#;

/// Default Bootstrap: the first-run onboarding conversation.
/// Uses `{{agentName}}` and `{{teamName}}` placeholders, replaced at agent creation time.
/// The platform token is auto-created server-side, so no MCP tool calls are needed during bootstrap.
const DEFAULT_BOOTSTRAP_MD: &str = r#"# Welcome

You are {{agentName}}, a new AI agent for the {{teamName}} team.

## Your First Conversation

Introduce yourself briefly to the user. Then learn about your purpose:

1. **What should this agent do?** — What tasks, workflows, or responsibilities should you handle?
2. **Focus areas** — Any specific tools, services, or areas you should focus on?
3. **Working style** — How should you communicate? (concise, detailed, formal, casual)

## When You Have Enough Context

Once you understand your purpose:

1. **update_soul** — Define your personality, focus areas, and boundaries.
2. **update_user_profile** — Record the team context, responsibilities, and what you're here to help with

Then call **clear_bootstrap** to complete onboarding.
"#;

/// Default Agent Guide: the agent's operating manual. It names when to ask and leaves when
/// a request is enough to each mode's own instructions: a chat request is approval, a
/// request spoken in a call is not.
const DEFAULT_AGENT_MD: &str = r#"## Safety

- Ask first when what the user wants is unclear, or before you change external state that nobody asked you to change.

## Heartbeat or scheduled task

- Your heartbeat runs all the checks in your heartbeat config together, once per heartbeat interval. Add a recurring check there when its exact time does not matter.
- Use a scheduled task for a reminder, for a check at a set time, or to continue a conversation later.
"#;

/// Default Vision: the user's goals and priorities for the agent to advance.
/// Starts empty: the user fills this in to make the agent proactive.
const DEFAULT_VISION_MD: &str = "";

/// The seven identity documents a new agent starts with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultWorkspaceFiles {
    pub soul_md: String,
    pub user_md: String,
    pub memory_md: String,
    pub heartbeat_md: String,
    pub bootstrap_md: String,
    pub vision_md: String,
    pub agent_md: String,
}

/// Get all default workspace files.
pub fn get_default_workspace_files() -> DefaultWorkspaceFiles {
    DefaultWorkspaceFiles {
        soul_md: DEFAULT_SOUL_MD.to_string(),
        user_md: DEFAULT_USER_MD.to_string(),
        memory_md: DEFAULT_MEMORY_MD.to_string(),
        heartbeat_md: DEFAULT_HEARTBEAT_MD.to_string(),
        bootstrap_md: DEFAULT_BOOTSTRAP_MD.to_string(),
        vision_md: DEFAULT_VISION_MD.to_string(),
        agent_md: DEFAULT_AGENT_MD.to_string(),
    }
}

/// Backwards compatibility alias of `get_default_workspace_files`.
pub fn get_default_bootstrap_files() -> DefaultWorkspaceFiles {
    get_default_workspace_files()
}

/// `String.prototype.trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

fn guide_digest(guide: &str) -> String {
    hex::encode(Sha256::digest(js_trim(guide).as_bytes()))
}

/// The sha256 of each trimmed Agent Guide that reads as a default guide: the current
/// one, and the one seeded from v2026.6.18060952 until this template, which the agents
/// created then still hold. The guide seeded before v2026.6.18060952 is left out, so it
/// reads as an edited guide (see `resolve_policy` in `lib/tool_risk_gate`).
static DEFAULT_AGENT_GUIDE_DIGESTS: LazyLock<HashSet<String>> = LazyLock::new(|| {
    HashSet::from([
        "88cdccd037b36a30ea4d85ce7a0c46659b242f43be24398de888dbf40ab2485d".to_string(),
        guide_digest(DEFAULT_AGENT_MD),
    ])
});

/// Whether a guide is a default guide that nobody edited.
pub fn is_default_agent_guide(guide: &str) -> bool {
    DEFAULT_AGENT_GUIDE_DIGESTS.contains(&guide_digest(guide))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_current_template_as_a_default_guide() {
        assert!(is_default_agent_guide(DEFAULT_AGENT_MD));
        assert!(is_default_agent_guide(&format!(
            "\n  {DEFAULT_AGENT_MD}  \n"
        )));
        assert!(!is_default_agent_guide(&format!(
            "{DEFAULT_AGENT_MD}\n- One more rule."
        )));
    }

    #[test]
    fn holds_seven_documents_with_an_empty_vision() {
        let files = get_default_workspace_files();
        assert_eq!(files.vision_md, "");
        assert!(
            files
                .bootstrap_md
                .contains("You are {{agentName}}, a new AI agent for the {{teamName}} team.")
        );
    }
}
