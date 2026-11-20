//! `coding_agent_sign_in`: the agent asking the person to sign a coding agent in
//! to their own Claude or ChatGPT subscription.
//!
//! Chat only: a person is there to answer. Offered for the coding agents whose
//! CLI runs here. The sign-in itself happens where the card opens it, so no code
//! passes through the conversation.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::ai::{Tool, ToolSet, execute_fn, tool, zod_schema};
use crate::config::CodingAgentName;
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::coding_agent_sign_in::coding_agent_sign_in_request_service::{
    CODING_AGENT_SIGN_IN_REQUEST_SERVICE, PROVIDERS, RequestedSignIn, SignInCaller,
};

pub const CODING_AGENT_SIGN_IN_TOOL_NAME: &str = "coding_agent_sign_in";
pub const CODING_AGENT_SIGN_IN_DESCRIPTION: &str = "Ask the user to sign a coding agent in to their own subscription, so its coding tasks run on it: claude-code on their Claude plan, codex on their ChatGPT plan. Call it when the user asks for that, or when a coding task failed because nobody is signed in to the subscription. It posts a card the user signs in from. Never ask for a sign-in code or link in chat, and never use one the user pastes in chat: point them to the card instead. Then finish this turn; when the sign-in succeeds, the user tells you so in a new message.";

#[derive(Debug, Clone, Deserialize)]
pub struct CodingAgentSignInInput {
    pub agent: CodingAgentName,
}

/// `{ agent: enum(agents) }`, the enum holding the offered agents in order.
pub fn coding_agent_sign_in_input_schema(agents: &[CodingAgentName]) -> Value {
    let names: Vec<&str> = agents.iter().map(|agent| agent.as_str()).collect();
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "agent": {
                "type": "string",
                "enum": names
            }
        },
        "required": ["agent"],
        "additionalProperties": false
    })
}

/// Empty without a thread or without an agent to offer. The tool posts the card
/// and answers `The user was asked to sign in to <provider>. Finish this turn.`,
/// or, when a card already waits, `A sign-in card for <provider> is already
/// waiting in this conversation, so nothing new was sent. Finish this turn.`
pub fn get_coding_agent_sign_in_tools(
    user_id: &str,
    agent_id: &str,
    thread_id: Option<&str>,
    origin_channel: ChannelName,
    origin_channel_id: Option<&str>,
    agents: &[CodingAgentName],
) -> ToolSet {
    let mut tools = ToolSet::new();
    let Some(thread_id) = thread_id else {
        return tools;
    };
    if agents.is_empty() {
        return tools;
    }
    let caller = SignInCaller {
        agent_id: agent_id.to_string(),
        user_id: user_id.to_string(),
        thread_id: thread_id.to_string(),
        origin_channel: Some(origin_channel),
        origin_channel_id: origin_channel_id.map(str::to_string),
    };
    tools.insert(
        CODING_AGENT_SIGN_IN_TOOL_NAME.to_string(),
        tool(Tool {
            description: Some(CODING_AGENT_SIGN_IN_DESCRIPTION.to_string()),
            input_schema: zod_schema(coding_agent_sign_in_input_schema(agents)),
            execute: Some(execute_fn(move |input, _| {
                let caller = caller.clone();
                async move {
                    let CodingAgentSignInInput { agent } = serde_json::from_value(input)?;
                    let RequestedSignIn { repeated, .. } =
                        CODING_AGENT_SIGN_IN_REQUEST_SERVICE.request(&caller, agent).await?;
                    let provider = PROVIDERS.get(agent);
                    let message = if repeated {
                        format!(
                            "A sign-in card for {provider} is already waiting in this conversation, so nothing new was sent. Finish this turn."
                        )
                    } else {
                        format!("The user was asked to sign in to {provider}. Finish this turn.")
                    };
                    Ok(json!({ "success": true, "message": message }))
                }
            })),
            ..Default::default()
        }),
    );
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_definition_matches_the_typescript_runtime() {
        let tools = get_coding_agent_sign_in_tools(
            "user-1",
            "agent-1",
            Some("thread-1"),
            ChannelName::Websocket,
            None,
            &[CodingAgentName::ClaudeCode, CodingAgentName::Codex],
        );
        crate::tools::schema_fixture::assert_matches_fixture("coding-agent-sign-in", &tools);
    }

    #[test]
    fn offers_nothing_without_a_thread_or_an_agent() {
        assert!(
            get_coding_agent_sign_in_tools(
                "user-1",
                "agent-1",
                None,
                ChannelName::Websocket,
                None,
                &[CodingAgentName::ClaudeCode],
            )
            .is_empty()
        );
        assert!(
            get_coding_agent_sign_in_tools(
                "user-1",
                "agent-1",
                Some("thread-1"),
                ChannelName::Websocket,
                None,
                &[],
            )
            .is_empty()
        );
    }

    #[test]
    fn offers_only_the_agents_whose_cli_runs_here() {
        assert_eq!(
            coding_agent_sign_in_input_schema(&[CodingAgentName::Codex])["properties"]["agent"]["enum"],
            json!(["codex"])
        );
    }
}
