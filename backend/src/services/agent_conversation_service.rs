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

use diesel::prelude::*;

use crate::config::CONFIG;
use crate::db::models::ThreadSource;
use crate::db::schema::conversation_threads::dsl as t;
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::services::runtime_state_service::RUNTIME_STATE_SERVICE;
use crate::services::web_thread::web_thread;

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
        let thread_id = RUNTIME_STATE_SERVICE
            .get(&conversation_key(conversation_id))
            .await?;
        let Some(thread_id) = thread_id.filter(|id| !id.is_empty()) else {
            return Ok(None);
        };
        let owner = CONFIG.owner_user_id();
        let filter = CONVERSATION_SERVICE
            .client_thread_filter(agent_id, &owner)
            .await?;
        let agent = agent_id.to_string();
        let thread = crate::db::run(move |conn| {
            Ok(t::conversation_threads
                .filter(t::id.eq(thread_id))
                .filter(t::agent_id.eq(agent))
                .filter(t::user_id.eq(owner))
                .filter(web_thread())
                .select(crate::db::models::ConversationThread::as_select())
                .first(conn)
                .optional()?)
        })
        .await?;
        Ok(thread
            .filter(|thread| filter.allows(thread))
            .map(|thread| thread.id))
    }

    /// Keep `conversation_id` in the web conversation that now holds it.
    pub async fn remember(&self, conversation_id: &str, thread_id: &str) -> anyhow::Result<()> {
        RUNTIME_STATE_SERVICE
            .set(&conversation_key(conversation_id), thread_id)
            .await
    }
}

impl Default for AgentConversationService {
    fn default() -> Self {
        Self::new()
    }
}

pub static AGENT_CONVERSATION_SERVICE: LazyLock<AgentConversationService> =
    LazyLock::new(AgentConversationService::new);
