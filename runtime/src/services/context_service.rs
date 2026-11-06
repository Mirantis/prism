//! Context Service
//!
//! Builds agent context by reading agent data and conversation history from the
//! local database.

use std::sync::LazyLock;

use crate::db::models::{ConversationMessage, ThreadSource};
use crate::prompts::context_builder::ConversationMessage as HistoryRow;
use crate::types::AgentContext;

/// What `get_agent_context` reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentContextOptions {
    pub agent_id: String,
    /// The thread to read; unset, the user's latest web thread.
    pub thread_id: Option<String>,
    /// Whether to read the conversation at all. Default `true`.
    pub include_conversation: Option<bool>,
    /// Override the agent's persisted verbose flag.
    pub verbose: Option<bool>,
}

pub struct ContextService;

impl ContextService {
    pub fn new() -> Self {
        ContextService
    }

    /// The agent's documents and settings, and, unless `include_conversation` is
    /// false, the thread's compaction summary and the messages in the model window.
    pub async fn get_agent_context(
        &self,
        user_id: &str,
        options: AgentContextOptions,
    ) -> anyhow::Result<AgentContext> {
        todo!()
    }

    /// Attach shared-file metadata to every message in the model
    /// window. The window is every non-compacted message — compaction
    /// (`compaction_service.rs`) bounds it in steady state by folding older history
    /// into the thread's summary, so there is deliberately no count-based slice
    /// here. Attachment bytes are never loaded into the context window — the
    /// agent pulls content on demand via hydrate_attachment / view_attachment
    /// tools. Attachment keys differ by source: DB threads key by message id,
    /// live-read threads key by the channel's message id (externalMessageId).
    /// A message with no text is kept when it is an agent row with tool calls, or
    /// carries files.
    async fn attach_files(
        &self,
        thread_id: &str,
        thread_source: ThreadSource,
        messages: Vec<ConversationMessage>,
    ) -> anyhow::Result<Vec<HistoryRow>> {
        todo!()
    }
}

impl Default for ContextService {
    fn default() -> Self {
        Self::new()
    }
}

pub static CONTEXT_SERVICE: LazyLock<ContextService> = LazyLock::new(ContextService::new);
