//! Context Service
//!
//! Builds agent context by reading agent data and conversation history from the
//! local database.

use std::sync::LazyLock;

use crate::db::models::{ConversationMessage, MessageRole, ThreadSource};
use crate::lib::model_selection::{StoredModelSelection, resolve_model_selection};
use crate::prompts::context_builder::ConversationMessage as HistoryRow;
use crate::services::agent_workspace_service::AGENT_WORKSPACE_SERVICE;
use crate::services::attachment_service::ATTACHMENT_SERVICE;
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::support::js;
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
        let include_conversation = options.include_conversation.unwrap_or(true);

        // 1. Fetch agent from database
        let agent = AGENT_WORKSPACE_SERVICE.get_agent().await?;

        let is_bootstrap_phase = !js::trim(&agent.bootstrap_md).is_empty();

        let mut context = AgentContext {
            soul_md: agent.soul_md.clone(),
            user_md: agent.user_md.clone(),
            memory_md: agent.memory_md.clone(),
            heartbeat_md: agent.heartbeat_md.clone(),
            bootstrap_md: agent.bootstrap_md.clone(),
            vision_md: agent.vision_md.clone(),
            agent_md: agent.agent_md.clone(),
            agent_name: agent.name.clone(),
            agent_id: agent.id.clone(),
            user_id: user_id.to_string(),
            model: agent.model.clone(),
            heartbeat_model: agent.heartbeat_model.clone(),
            cron_model: agent.cron_model.clone(),
            model_selection: resolve_model_selection(&StoredModelSelection::from(&agent)),
            verbose: options.verbose.unwrap_or(agent.verbose),
            locked_in: agent.locked_in,
            is_bootstrap_phase,
            conversation_summary: None,
            compacted_history_readable: false,
            recent_messages: Vec::new(),
            posting_ceiling: None,
            last_send: None,
            runtime_notices: None,
        };

        // 2. Resolve thread and fetch conversation
        let mut resolved_thread_id = options.thread_id.clone();
        if include_conversation && resolved_thread_id.is_none() {
            let thread = CONVERSATION_SERVICE
                .find_latest_web_thread(&options.agent_id, user_id)
                .await?;
            resolved_thread_id = thread.map(|thread| thread.id);
        }

        if let Some(thread_id) = resolved_thread_id.filter(|_| include_conversation) {
            let thread_context = CONVERSATION_SERVICE.get_thread_context(&thread_id).await?;
            context.conversation_summary = thread_context.compaction_summary;
            context.compacted_history_readable =
                thread_context.thread_source == ThreadSource::Database;
            context.recent_messages = self
                .attach_files(
                    &thread_id,
                    thread_context.thread_source,
                    thread_context.messages,
                )
                .await?;
        }

        Ok(context)
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
        let live_read = thread_source != ThreadSource::Database;
        let key_of = |m: &ConversationMessage| -> String {
            if live_read {
                m.external_message_id.clone().unwrap_or_default()
            } else {
                m.id.clone()
            }
        };

        let meta_map = if live_read {
            let external_ids: Vec<String> = messages
                .iter()
                .filter_map(|m| m.external_message_id.clone())
                .filter(|ts| !ts.is_empty())
                .collect();
            ATTACHMENT_SERVICE
                .get_meta_by_external_ts(thread_id, &external_ids)
                .await?
        } else {
            let ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
            ATTACHMENT_SERVICE.get_meta_by_message_ids(&ids).await?
        };

        let windowed: Vec<ConversationMessage> = messages
            .into_iter()
            .filter(|m| {
                !js::trim(&m.content).is_empty()
                    || (m.role == MessageRole::Agent
                        && m.tool_calls.as_ref().is_some_and(js::truthy))
                    || meta_map.contains_key(&key_of(m))
            })
            .collect();

        if meta_map.is_empty() {
            return Ok(windowed.into_iter().map(HistoryRow::from_row).collect());
        }

        Ok(windowed
            .into_iter()
            .map(|m| {
                let attachments = meta_map
                    .get(&key_of(&m))
                    .filter(|attachments| !attachments.is_empty())
                    .cloned();
                let mut row = HistoryRow::from_row(m);
                if attachments.is_some() {
                    row.attachments = attachments;
                }
                row
            })
            .collect())
    }
}

impl Default for ContextService {
    fn default() -> Self {
        Self::new()
    }
}

pub static CONTEXT_SERVICE: LazyLock<ContextService> = LazyLock::new(ContextService::new);
