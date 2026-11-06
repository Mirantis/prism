//! What a task and the desktop's terminal share about the subscription switch:
//! where it is stored, which environment holds it on, and what a coding agent
//! says when it is on and nobody is signed in.
//!
//! Reads nothing from the configuration, so the terminal's `coding_agent_exec`
//! uses it without starting the runtime.

use std::collections::HashMap;

use crate::config::CodingAgentName;

/// The `runtime_state` key that holds the switch, `on` or absent.
pub fn subscription_key(agent: CodingAgentName) -> String {
    format!("codingAgentSubscription:{}", agent.as_str())
}

/// Whether `CLAUDE_CODE_SUBSCRIPTION` or `CODEX_SUBSCRIPTION` holds the switch on.
pub fn subscription_forced_in(env: &HashMap<String, String>, agent: CodingAgentName) -> bool {
    let name = match agent {
        CodingAgentName::ClaudeCode => "CLAUDE_CODE_SUBSCRIPTION",
        CodingAgentName::Codex => "CODEX_SUBSCRIPTION",
    };
    env.get(name)
        .is_some_and(|value| value.trim().to_lowercase() == "true")
}

/// What a coding agent says when it is set to use the subscription and nobody is
/// signed in. Coding agents signs in to the home in the deployment's environment;
/// a task in a folder outside it runs on this computer, from `host_home`, so the
/// message names the command that signs in there instead.
pub fn not_signed_in_message(agent: CodingAgentName, host_home: Option<&str>) -> String {
    let set_to = match agent {
        CodingAgentName::ClaudeCode => "Claude Code is set to use your Claude subscription",
        CodingAgentName::Codex => "Codex is set to use your ChatGPT subscription",
    };
    let Some(host_home) = host_home.filter(|home| !home.is_empty()) else {
        return format!(
            "{set_to}, and nobody is signed in to it: sign in again from Coding agents"
        );
    };
    let home = format!("'{}'", host_home.replace('\'', "'\\''"));
    let command = match agent {
        CodingAgentName::ClaudeCode => {
            format!("CLAUDE_CONFIG_DIR={home} claude auth login --claudeai")
        }
        CodingAgentName::Codex => {
            format!("CODEX_HOME={home} codex login -c 'cli_auth_credentials_store=\"file\"'")
        }
    };
    format!(
        "{set_to}, and nobody is signed in to it on this computer, where this conversation's folder is. \
         Coding agents signs in elsewhere: sign in by running `{command}` in a terminal on this computer"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_switch_key_per_agent() {
        assert_eq!(
            subscription_key(CodingAgentName::ClaudeCode),
            "codingAgentSubscription:claude-code"
        );
        assert_eq!(
            subscription_key(CodingAgentName::Codex),
            "codingAgentSubscription:codex"
        );
    }

    #[test]
    fn reads_the_forcing_variable_of_each_agent() {
        let env: HashMap<String, String> =
            [("CLAUDE_CODE_SUBSCRIPTION".to_string(), " TRUE ".to_string())]
                .into_iter()
                .collect();
        assert!(subscription_forced_in(&env, CodingAgentName::ClaudeCode));
        assert!(!subscription_forced_in(&env, CodingAgentName::Codex));
    }

    #[test]
    fn quotes_the_host_home_in_the_sign_in_command() {
        assert_eq!(
            not_signed_in_message(CodingAgentName::Codex, Some("/home/o'neil")),
            "Codex is set to use your ChatGPT subscription, and nobody is signed in to it on this computer, \
             where this conversation's folder is. Coding agents signs in elsewhere: sign in by running \
             `CODEX_HOME='/home/o'\\''neil' codex login -c 'cli_auth_credentials_store=\"file\"'` in a terminal \
             on this computer"
        );
        assert_eq!(
            not_signed_in_message(CodingAgentName::ClaudeCode, None),
            "Claude Code is set to use your Claude subscription, and nobody is signed in to it: sign in again from Coding agents"
        );
    }
}
