//! `coding_agent_sign_in`: the agent asking the person to sign a coding agent in
//! to their own Claude or ChatGPT subscription.
//!
//! Chat only: a person is there to answer. Offered for the coding agents whose
//! CLI runs here. The sign-in itself happens where the card opens it, so no code
//! passes through the conversation.

use serde::Deserialize;
use serde_json::Value;

use crate::ai::ToolSet;
use crate::config::CodingAgentName;
use crate::services::channel_adapter_interface::ChannelName;

pub const CODING_AGENT_SIGN_IN_TOOL_NAME: &str = "coding_agent_sign_in";
pub const CODING_AGENT_SIGN_IN_DESCRIPTION: &str = "Ask the user to sign a coding agent in to their own subscription, so its coding tasks run on it: claude-code on their Claude plan, codex on their ChatGPT plan. Call it when the user asks for that, or when a coding task failed because nobody is signed in to the subscription. It posts a card the user signs in from. Never ask for a sign-in code or link in chat, and never use one the user pastes in chat: point them to the card instead. Then finish this turn; when the sign-in succeeds, the user tells you so in a new message.";

#[derive(Debug, Clone, Deserialize)]
pub struct CodingAgentSignInInput {
    pub agent: CodingAgentName,
}

/// `{ agent: enum(agents) }`, the enum holding the offered agents in order.
pub fn coding_agent_sign_in_input_schema(agents: &[CodingAgentName]) -> Value {
    todo!("JSON Schema supplied by the coordinator")
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
    todo!()
}
