//! Agent Conversation Service
//!
//! Which web conversation holds each conversation between agents, so the next
//! message of one arrives beside the last. The delivery service gives every
//! message a `conversationId`: a new message starts one, and a reply, and a
//! notice about a message, carry the one it belongs to. The web conversation a
//! delivery lands in is kept under `agentConversation:<conversationId>` in
//! `runtime_state`. The runtime never reads the agent's own messages to other
//! agents, so an answer to one arrives where an unknown conversation does.

use std::sync::LazyLock;

/// The `runtime_state` key that holds the web conversation of `conversation_id`.
fn conversation_key(conversation_id: &str) -> String {
    format!("agentConversation:{conversation_id}")
}

pub struct AgentConversationService;

impl AgentConversationService {
    pub fn new() -> Self {
        AgentConversationService
    }

    /// The web conversation that holds `conversation_id`, while a client can still
    /// write to it. `None` when none does yet, when it was deleted, and when
    /// single-thread mode hides it.
    pub async fn thread_for(
        &self,
        conversation_id: &str,
        agent_id: &str,
    ) -> anyhow::Result<Option<String>> {
        todo!()
    }

    /// Keep `conversation_id` in the web conversation that now holds it.
    pub async fn remember(&self, conversation_id: &str, thread_id: &str) -> anyhow::Result<()> {
        todo!()
    }
}

impl Default for AgentConversationService {
    fn default() -> Self {
        Self::new()
    }
}

pub static AGENT_CONVERSATION_SERVICE: LazyLock<AgentConversationService> =
    LazyLock::new(AgentConversationService::new);
