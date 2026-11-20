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

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use diesel::prelude::*;
    use serde_json::json;

    use super::*;
    use crate::db::models::{
        MessageTrigger, NewAgentWorkspace, NewConversationMessage, NewConversationThread,
        NewMessageAttachment,
    };
    use crate::db::schema::{
        agent_workspaces, conversation_messages, conversation_threads, message_attachments,
    };
    use crate::db::testing::{TestDb, test_db};

    const AGENT: &str = "test-agent-id";

    fn seed_agent(test: &TestDb, bootstrap_md: &str) {
        let bootstrap_md = bootstrap_md.to_string();
        test.db
            .run_sync(move |conn| {
                let mut agent = NewAgentWorkspace::new(
                    "user-1",
                    "soul content",
                    "user content",
                    "memory content",
                    "heartbeat content",
                    bootstrap_md,
                );
                agent.id = AGENT.into();
                agent.name = "Test Agent".into();
                agent.vision_md = "vision content".into();
                agent.agent_md = "agent guide".into();
                diesel::insert_into(agent_workspaces::table)
                    .values(&agent)
                    .execute(conn)?;
                Ok(())
            })
            .unwrap();
    }

    fn seed_thread(test: &TestDb, id: &str, summary: Option<&str>, minutes_ago: i64) {
        let id = id.to_string();
        let summary = summary.map(str::to_string);
        test.db
            .run_sync(move |conn| {
                let mut thread = NewConversationThread::new(AGENT, "user-1");
                thread.id = id;
                thread.compaction_summary = summary;
                let at = Utc::now() - Duration::minutes(minutes_ago);
                thread.created_at = at.into();
                thread.updated_at = at.into();
                diesel::insert_into(conversation_threads::table)
                    .values(&thread)
                    .execute(conn)?;
                Ok(())
            })
            .unwrap();
    }

    fn seed_message(test: &TestDb, message: NewConversationMessage) {
        test.db
            .run_sync(move |conn| {
                diesel::insert_into(conversation_messages::table)
                    .values(&message)
                    .execute(conn)?;
                Ok(())
            })
            .unwrap();
    }

    fn message(id: &str, role: MessageRole, content: &str, seconds: i64) -> NewConversationMessage {
        let mut message =
            NewConversationMessage::new("thread-1", role, content, MessageTrigger::UserInput);
        message.id = id.into();
        message.created_at = (Utc::now() - Duration::hours(1) + Duration::seconds(seconds)).into();
        message
    }

    fn options(thread_id: Option<&str>, include_conversation: Option<bool>) -> AgentContextOptions {
        AgentContextOptions {
            agent_id: AGENT.into(),
            thread_id: thread_id.map(str::to_string),
            include_conversation,
            verbose: None,
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn maps_agent_fields_into_the_context() {
        let test = test_db();
        seed_agent(&test, "");
        let context = CONTEXT_SERVICE
            .get_agent_context("user-1", options(None, Some(false)))
            .await
            .unwrap();
        assert_eq!(context.soul_md, "soul content");
        assert_eq!(context.user_md, "user content");
        assert_eq!(context.memory_md, "memory content");
        assert_eq!(context.heartbeat_md, "heartbeat content");
        assert_eq!(context.vision_md, "vision content");
        assert_eq!(context.agent_md, "agent guide");
        assert_eq!(context.agent_name, "Test Agent");
        assert_eq!(context.agent_id, AGENT);
        assert_eq!(context.user_id, "user-1");
        assert!(!context.is_bootstrap_phase);
        assert!(context.conversation_summary.is_none());
        assert!(context.recent_messages.is_empty());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn is_in_the_bootstrap_phase_only_while_bootstrap_md_has_content() {
        for (bootstrap_md, expected) in [("Welcome!", true), ("", false), ("  \n\t ", false)] {
            let test = test_db();
            seed_agent(&test, bootstrap_md);
            let context = CONTEXT_SERVICE
                .get_agent_context("user-1", options(None, Some(false)))
                .await
                .unwrap();
            assert_eq!(context.is_bootstrap_phase, expected, "{bootstrap_md:?}");
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn the_verbose_option_overrides_the_agent_setting() {
        let test = test_db();
        seed_agent(&test, "");
        let mut verbose = options(None, Some(false));
        verbose.verbose = Some(true);
        let context = CONTEXT_SERVICE
            .get_agent_context("user-1", verbose)
            .await
            .unwrap();
        assert!(context.verbose);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reads_the_named_thread_its_summary_and_its_messages() {
        let test = test_db();
        seed_agent(&test, "");
        seed_thread(&test, "thread-1", Some("Earlier work."), 10);
        seed_message(&test, message("m1", MessageRole::User, "hello", 1));
        seed_message(&test, message("m2", MessageRole::Agent, "hi", 2));

        let context = CONTEXT_SERVICE
            .get_agent_context("user-1", options(Some("thread-1"), Some(true)))
            .await
            .unwrap();

        assert_eq!(
            context.conversation_summary.as_deref(),
            Some("Earlier work.")
        );
        assert!(context.compacted_history_readable);
        let ids: Vec<&str> = context
            .recent_messages
            .iter()
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(ids, ["m1", "m2"]);
        assert_eq!(
            context.recent_messages[0].triggered_by.as_deref(),
            Some("USER_INPUT")
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reads_the_latest_web_thread_when_no_thread_is_named() {
        let test = test_db();
        seed_agent(&test, "");
        seed_thread(&test, "thread-old", None, 60);
        seed_thread(&test, "thread-1", None, 1);
        seed_message(&test, message("m1", MessageRole::User, "newest", 1));

        let context = CONTEXT_SERVICE
            .get_agent_context("user-1", options(None, None))
            .await
            .unwrap();

        assert_eq!(context.recent_messages.len(), 1);
        assert_eq!(context.recent_messages[0].content, "newest");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reads_no_conversation_when_the_user_has_no_thread() {
        let test = test_db();
        seed_agent(&test, "");
        let context = CONTEXT_SERVICE
            .get_agent_context("user-1", options(None, Some(true)))
            .await
            .unwrap();
        assert!(context.recent_messages.is_empty());
        assert!(context.conversation_summary.is_none());
        assert!(!context.compacted_history_readable);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn keeps_a_message_with_text_tool_calls_or_files_and_drops_the_rest() {
        let test = test_db();
        seed_agent(&test, "");
        seed_thread(&test, "thread-1", None, 10);
        seed_message(&test, message("m1", MessageRole::User, "hello", 1));
        seed_message(&test, message("m2", MessageRole::User, "   ", 2));
        seed_message(&test, message("m3", MessageRole::Agent, "", 3));
        let mut with_calls = message("m4", MessageRole::Agent, "", 4);
        with_calls.tool_calls =
            Some(json!([{ "tool": "list_pods", "input": "{}", "output": "[]" }]));
        seed_message(&test, with_calls);
        seed_message(&test, message("m5", MessageRole::User, "", 5));
        test.db
            .run_sync(|conn| {
                let mut file = NewMessageAttachment::new("pic.png", "image/png", 3, "image", "web");
                file.id = "att-1".into();
                file.message_id = Some("m5".into());
                file.thread_id = Some("thread-1".into());
                file.data = Some(vec![1, 2, 3]);
                diesel::insert_into(message_attachments::table)
                    .values(&file)
                    .execute(conn)?;
                Ok(())
            })
            .unwrap();

        let context = CONTEXT_SERVICE
            .get_agent_context("user-1", options(Some("thread-1"), None))
            .await
            .unwrap();

        let ids: Vec<&str> = context
            .recent_messages
            .iter()
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(ids, ["m1", "m4", "m5"]);
        assert!(context.recent_messages[0].attachments.is_none());
        let files = context.recent_messages[2].attachments.as_ref().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].id, "att-1");
        assert_eq!(files[0].filename, "pic.png");
        assert!(!files[0].expired);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn keeps_every_uncompacted_message_with_no_count_window() {
        let test = test_db();
        seed_agent(&test, "");
        seed_thread(&test, "thread-1", None, 10);
        for i in 0..60 {
            seed_message(
                &test,
                message(
                    &format!("m{i:02}"),
                    MessageRole::User,
                    &format!("message {i}"),
                    i,
                ),
            );
        }
        let context = CONTEXT_SERVICE
            .get_agent_context("user-1", options(Some("thread-1"), None))
            .await
            .unwrap();
        assert_eq!(context.recent_messages.len(), 60);
    }
}
