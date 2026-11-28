//! Conversation Service
//!
//! Manages conversation threads and messages for the personal agent.
//! Handles thread creation, message persistence, and retrieval.

use std::borrow::Borrow;
use std::collections::HashMap;
use std::ops::{Deref, DerefMut};
use std::sync::{Arc, LazyLock};

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::sqlite::{Sqlite, SqliteConnection};
use indexmap::IndexMap;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::{CONFIG, ThreadMode};
use crate::db::models::{
    ConversationMessage, ConversationThread, ConversationThreadChangeset, MessageRole,
    MessageTrigger, NewConversationMessage, NewConversationThread, ThreadSource,
};
use crate::db::schema::conversation_messages::dsl as m;
use crate::db::schema::conversation_threads::{self, dsl as t};
use crate::db::sql_types::DbDateTime;
use crate::lib::agent_message_kind::agent_message_kind;
use crate::lib::context_window::{ContextUsageSnapshot, build_context_snapshot};
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::{agent_props, track_event};
use crate::protocol::chat_protocol::AgentMessageKind;
use crate::services::attachment_service::{ATTACHMENT_SERVICE, HasMessageId, WithAttachments};
use crate::services::conversation_search_service::CONVERSATION_SEARCH_SERVICE;
use crate::services::providers::database_thread_provider::DatabaseThreadProvider;
use crate::services::runtime_state_service::{RUNTIME_STATE_SERVICE, SINGLE_THREAD};
use crate::services::thread_provider_interface::{
    MessageReadOptions, MessageView, ThreadMessageProvider,
};
use crate::services::web_thread::web_thread;
use crate::support::js;
use crate::utils::thread_title::derive_thread_title;
use crate::{log_info, log_warn};

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Clone)]
pub struct MessageInput {
    /// The row's id, when the sender chose it. A chat client names its message so a
    /// resend after a dropped connection finds the row it already wrote instead of
    /// writing a second one. Omitted, a new id is minted.
    pub id: Option<String>,
    pub content: String,
    pub role: MessageRole,
    pub triggered_by: MessageTrigger,
    /// The webhook subscription that produced a WEBHOOK message, or the kind of an
    /// AGENT_MESSAGE, for the model's history.
    pub trigger_name: Option<String>,
    /// The stored tool calls, a JSON array.
    pub tool_calls: Option<Value>,
    /// The stored UI blocks, a JSON array.
    pub blocks: Option<Value>,
    /// The sender's id in the channel the message came from.
    pub sender_external_id: Option<String>,
    /// Human-readable display name.
    pub sender_name: Option<String>,
    /// The id the message has outside this database, such as another agent's message id.
    pub external_message_id: Option<String>,
    /// Marks a row the runtime wrote for the model, never for the reader.
    ///
    /// **An internal row is never shown to the end user.** Every client history read
    /// asks for the `Client` view, and both thread providers answer that with
    /// `internalStep: false` in the WHERE clause — so every client and channel
    /// omit it, while the model-context read replays it. It also never names a thread,
    /// and it is reported separately in `message added` telemetry so it cannot be
    /// counted as something a user sent.
    ///
    /// Two writers today: concise mode's intermediate steps, and a turn's recalled
    /// memories. Omit (or false) for a normal, user-visible message.
    pub internal_step: Option<bool>,
}

impl MessageInput {
    /// A message with only its text, role and trigger set.
    pub fn new(
        content: impl Into<String>,
        role: MessageRole,
        triggered_by: MessageTrigger,
    ) -> Self {
        Self {
            id: None,
            content: content.into(),
            role,
            triggered_by,
            trigger_name: None,
            tool_calls: None,
            blocks: None,
            sender_external_id: None,
            sender_name: None,
            external_message_id: None,
            internal_step: None,
        }
    }
}

/// What `add_message` stored, and the title it just gave the thread, if any.
#[derive(Debug, Clone)]
pub struct AddedMessage {
    pub message: ConversationMessage,
    /// The title just assigned to the thread from this (first user) message, or
    /// `None` when no title was set (non-USER, empty content, or the thread is
    /// already titled). Callers use it to push a live title update to clients.
    pub title_set: Option<String>,
}

/// One page of a thread's client history: `limit` messages, the newest ones or those before `before`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessagePage {
    pub limit: i64,
    /// A message id; the page ends just before it.
    pub before: Option<String>,
}

/// A web thread came into being — emitted as `thread` on `CONVERSATION_SERVICE.events`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCreated {
    pub user_id: String,
    pub thread_id: String,
    pub title: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
}

/// A message was stored in a thread — emitted as `message` on `CONVERSATION_SERVICE.events`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageStored {
    pub user_id: String,
    pub agent_id: String,
    pub thread_id: String,
    pub triggered_by: MessageTrigger,
}

/// A client's copy of a stored message names its sender as the chat socket's
/// `message` event does, so history and live messages have one shape: a client
/// that tells its own messages from others' by `senderId`, or labels another
/// agent's by `agentMessageKind`, must find them on both.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithSender<T> {
    #[serde(flatten)]
    pub inner: T,
    pub sender_id: Option<String>,
    pub agent_message_kind: Option<AgentMessageKind>,
}

impl<T> Deref for WithSender<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.inner
    }
}

impl<T> DerefMut for WithSender<T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.inner
    }
}

impl<T: HasMessageId> HasMessageId for WithSender<T> {
    fn message_id(&self) -> &str {
        self.inner.message_id()
    }
    fn message_content(&self) -> &str {
        self.inner.message_content()
    }
}

/// The message with its sender named for a client.
fn with_sender<T: Borrow<ConversationMessage>>(message: T) -> WithSender<T> {
    let (sender_id, kind) = {
        let row: &ConversationMessage = message.borrow();
        (
            row.sender_external_id.clone(),
            agent_message_kind(&row.triggered_by, row.trigger_name.as_deref()),
        )
    };
    WithSender {
        inner: message,
        sender_id,
        agent_message_kind: kind,
    }
}

pub type MessageWithAttachments = WithAttachments<ConversationMessage>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadWithMessages {
    #[serde(flatten)]
    pub thread: ConversationThread,
    pub messages: Vec<WithSender<MessageWithAttachments>>,
    /// Context occupancy derived from the thread's stored snapshot, so a reload
    /// restores the context-window indicator without waiting for the next turn.
    /// `None` before the thread's first turn, or when `contextModel`'s window is
    /// unknown.
    pub context_usage: Option<ContextUsageSnapshot>,
}

/// The threads a client may list, read or write to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientThreadFilter {
    /// In single-thread mode, the one conversation's id (empty when there is none):
    /// a client sees it and the channel threads. `None` in multi-thread mode, where
    /// a client sees every thread.
    pub single_thread_id: Option<String>,
}

impl ClientThreadFilter {
    /// Whether a client may see `thread`.
    pub fn allows(&self, thread: &ConversationThread) -> bool {
        match &self.single_thread_id {
            None => true,
            Some(id) => thread.external_thread_id.is_some() || &thread.id == id,
        }
    }
}

/// Options of `start_new_thread`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StartThreadOptions {
    /// The working directory this conversation is rooted in (e.g. the CLI's launch
    /// cwd). Empty / whitespace-only values are ignored.
    pub workspace_root: Option<String>,
}

/// A thread whose history the channel keeps, read through the provider
/// registered for `source`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveThread {
    pub source: ThreadSource,
    pub channel_id: String,
}

/// Options of `list_threads`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListThreadsOptions {
    /// Default 20.
    pub limit: Option<i64>,
    pub thread_source: Option<ThreadSource>,
    /// Only the threads rooted in this folder, so the limit counts those alone.
    pub workspace_root: Option<String>,
}

/// A thread with its compaction summary, for context building.
#[derive(Debug, Clone)]
pub struct StoredThreadContext {
    pub compaction_summary: Option<String>,
    pub thread_source: ThreadSource,
    pub messages: Vec<ConversationMessage>,
}

/// A thread idle compaction may have to finish after a restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleCompactionCandidate {
    pub id: String,
    pub agent_id: String,
    pub user_id: String,
    pub compacted_at: Option<DateTime<Utc>>,
}

/// Receives each `thread` event.
pub type ThreadCreatedListener = Arc<dyn Fn(&ThreadCreated) + Send + Sync>;

/// Receives each `message` event.
pub type MessageStoredListener = Arc<dyn Fn(&MessageStored) + Send + Sync>;

/// The `thread` events (a web thread was created) and `message` events (a message
/// was stored in a thread).
#[derive(Default)]
pub struct ConversationEvents {
    thread: RwLock<Vec<ThreadCreatedListener>>,
    message: RwLock<Vec<MessageStoredListener>>,
}

impl ConversationEvents {
    /// Call `listener` with every created web thread from now on.
    pub fn on_thread(&self, listener: impl Fn(&ThreadCreated) + Send + Sync + 'static) {
        self.thread.write().push(Arc::new(listener));
    }

    /// Hand `event` to every listener, synchronously and in subscription order.
    pub fn emit_thread(&self, event: &ThreadCreated) {
        let listeners = self.thread.read().clone();
        for listener in listeners {
            listener(event);
        }
    }

    /// Call `listener` with every stored message from now on.
    pub fn on_message(&self, listener: impl Fn(&MessageStored) + Send + Sync + 'static) {
        self.message.write().push(Arc::new(listener));
    }

    /// Hand `event` to every listener, synchronously and in subscription order.
    pub fn emit_message(&self, event: &MessageStored) {
        let listeners = self.message.read().clone();
        for listener in listeners {
            listener(event);
        }
    }
}

// ============================================================================
// Conversation Service
// ============================================================================

pub struct ConversationService {
    /// Emits `thread` (`ThreadCreated`) when a web thread is created, and `message`
    /// (`MessageStored`) when a message is stored in a thread.
    pub events: ConversationEvents,
    database_provider: Arc<dyn ThreadMessageProvider>,
    live_providers: RwLock<HashMap<ThreadSource, Arc<dyn ThreadMessageProvider>>>,
}

/// The thread mode, which a test may set.
fn thread_mode() -> ThreadMode {
    #[cfg(test)]
    if let Some(mode) = *testing::THREAD_MODE.lock() {
        return mode;
    }
    CONFIG.thread_mode
}

/// The threads of `filter`, on a thread query.
fn client_threads<'a>(
    query: conversation_threads::BoxedQuery<'a, Sqlite>,
    filter: &ClientThreadFilter,
) -> conversation_threads::BoxedQuery<'a, Sqlite> {
    match &filter.single_thread_id {
        None => query,
        Some(id) => query.filter(t::external_thread_id.is_not_null().or(t::id.eq(id.clone()))),
    }
}

/// `trackEvent`'s props, in the order given.
fn props<const N: usize>(entries: [(&str, String); N]) -> IndexMap<String, String> {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect()
}

/// The row of a message `input` adds to `thread_id`.
fn message_row(thread_id: &str, input: &MessageInput) -> NewConversationMessage {
    let mut row = NewConversationMessage::new(
        thread_id,
        input.role,
        input.content.clone(),
        input.triggered_by,
    );
    if let Some(id) = input.id.clone().filter(|id| !id.is_empty()) {
        row.id = id;
    }
    row.trigger_name = input.trigger_name.clone();
    row.tool_calls = input.tool_calls.clone();
    row.blocks = input.blocks.clone();
    row.sender_external_id = input.sender_external_id.clone();
    row.sender_name = input.sender_name.clone();
    row.external_message_id = input.external_message_id.clone();
    row.internal_step = input.internal_step.unwrap_or(false);
    row
}

/// `message added` telemetry for a stored message.
fn track_message_added(agent_id: &str, thread_id: &str, input: &MessageInput) {
    let mut tracked = IndexMap::new();
    if !agent_id.is_empty() {
        tracked.insert("agent.id".to_string(), agent_id.to_string());
    }
    tracked.insert("thread.id".to_string(), thread_id.to_string());
    tracked.insert("message.role".to_string(), input.role.as_str().to_string());
    tracked.insert(
        "message.triggered_by".to_string(),
        input.triggered_by.as_str().to_string(),
    );
    // Internal rows are written by the runtime, not sent by anyone. Without this a
    // recalling chat turn adds a second `role=USER` count and every message-volume
    // metric steps at deploy for a reason that is not user behaviour.
    tracked.insert(
        "message.internal".to_string(),
        input.internal_step.unwrap_or(false).to_string(),
    );
    track_event("message added", None, Some(tracked));
}

impl ConversationService {
    pub fn new() -> Self {
        Self {
            events: ConversationEvents::default(),
            database_provider: Arc::new(DatabaseThreadProvider::new()),
            live_providers: RwLock::new(HashMap::new()),
        }
    }

    /// Single-thread mode's one conversation, stored under `SINGLE_THREAD` so no later
    /// write moves it. With none stored, or once its thread is gone, it is the web thread
    /// the person wrote in last, else the newest web thread. A daily session reset in
    /// multi-thread mode leaves an empty newest thread, which must not hide the
    /// conversation the person had.
    async fn single_thread(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Option<ConversationThread>> {
        let stored_id = RUNTIME_STATE_SERVICE.get(SINGLE_THREAD).await?;
        if let Some(stored_id) = stored_id.filter(|id| !id.is_empty()) {
            let (agent, user) = (agent_id.to_string(), user_id.to_string());
            let stored = crate::db::run(move |conn| {
                Ok(t::conversation_threads
                    .filter(t::id.eq(stored_id))
                    .filter(t::agent_id.eq(agent))
                    .filter(t::user_id.eq(user))
                    .filter(t::external_thread_id.is_null())
                    .select(ConversationThread::as_select())
                    .first(conn)
                    .optional()?)
            })
            .await?;
            if stored.is_some() {
                return Ok(stored);
            }
        }

        let (agent, user) = (agent_id.to_string(), user_id.to_string());
        let last_written = crate::db::run(move |conn| {
            Ok(m::conversation_messages
                .inner_join(t::conversation_threads)
                .filter(m::role.eq(MessageRole::User))
                .filter(m::triggered_by.eq(MessageTrigger::UserInput))
                .filter(m::internal_step.eq(false))
                .filter(t::agent_id.eq(agent))
                .filter(t::user_id.eq(user))
                .filter(t::external_thread_id.is_null())
                .order((m::created_at.desc(), m::id.desc()))
                .select(ConversationThread::as_select())
                .first(conn)
                .optional()?)
        })
        .await?;
        let chosen = match last_written {
            Some(thread) => Some(thread),
            None => self.newest_web_thread(agent_id, user_id).await?,
        };
        if let Some(chosen) = &chosen {
            RUNTIME_STATE_SERVICE.set(SINGLE_THREAD, &chosen.id).await?;
        }
        Ok(chosen)
    }

    /// Forget single-thread mode's conversation, so the next single-thread boot keeps the
    /// conversation the person wrote in last rather than the one it kept before.
    pub async fn forget_single_thread(&self) -> anyhow::Result<()> {
        RUNTIME_STATE_SERVICE.delete(SINGLE_THREAD).await
    }

    /// The thread a run or a chat turn that names `thread_id` writes to. In single-thread
    /// mode another web thread resolves to the one conversation, so a task or goal bound
    /// to an older conversation answers where every client shows it.
    pub async fn writable_thread_id(&self, thread_id: &str) -> anyhow::Result<String> {
        if thread_mode() != ThreadMode::Single {
            return Ok(thread_id.to_string());
        }
        let id = thread_id.to_string();
        let thread = crate::db::run(move |conn| {
            Ok(t::conversation_threads
                .filter(t::id.eq(id))
                .select((t::agent_id, t::user_id, t::external_thread_id))
                .first::<(String, String, Option<String>)>(conn)
                .optional()?)
        })
        .await?;
        let Some((agent_id, user_id, None)) = thread else {
            return Ok(thread_id.to_string());
        };
        Ok(self
            .get_or_create_latest_thread(&agent_id, &user_id)
            .await?
            .id)
    }

    async fn newest_web_thread(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Option<ConversationThread>> {
        let (agent, user) = (agent_id.to_string(), user_id.to_string());
        crate::db::run(move |conn| {
            Ok(t::conversation_threads
                .filter(t::agent_id.eq(agent))
                .filter(t::user_id.eq(user))
                .filter(t::external_thread_id.is_null())
                .order(t::created_at.desc())
                .select(ConversationThread::as_select())
                .first(conn)
                .optional()?)
        })
        .await
    }

    /// The threads a client may list, read or write to. In single-thread mode that is
    /// the one conversation and the channel threads; every other web thread stays in
    /// the database for when the agent runs in multi-thread mode again.
    pub async fn client_thread_filter(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> anyhow::Result<ClientThreadFilter> {
        if thread_mode() != ThreadMode::Single {
            return Ok(ClientThreadFilter {
                single_thread_id: None,
            });
        }
        let conversation = self.single_thread(agent_id, user_id).await?;
        Ok(ClientThreadFilter {
            single_thread_id: Some(conversation.map(|thread| thread.id).unwrap_or_default()),
        })
    }

    /// Serve every thread of `source` from `provider`, which reads the channel live.
    pub fn register_thread_provider(
        &self,
        source: ThreadSource,
        provider: Arc<dyn ThreadMessageProvider>,
    ) {
        self.live_providers.write().insert(source, provider);
    }

    fn provider_for(&self, source: Option<ThreadSource>) -> Arc<dyn ThreadMessageProvider> {
        source
            .and_then(|source| self.live_providers.read().get(&source).cloned())
            .unwrap_or_else(|| Arc::clone(&self.database_provider))
    }

    /// Resolve the message provider for a thread based on its threadSource.
    async fn resolve_provider(
        &self,
        thread_id: &str,
    ) -> anyhow::Result<Arc<dyn ThreadMessageProvider>> {
        Ok(self.provider_for(self.get_thread_source(thread_id).await?))
    }

    /// Where a thread's messages are read from, or `None` for a thread that does not exist.
    pub async fn get_thread_source(&self, thread_id: &str) -> anyhow::Result<Option<ThreadSource>> {
        let id = thread_id.to_string();
        crate::db::run(move |conn| {
            Ok(t::conversation_threads
                .filter(t::id.eq(id))
                .select(t::thread_source)
                .first::<ThreadSource>(conn)
                .optional()?)
        })
        .await
    }

    /// Get or create the latest database conversation thread for a user.
    ///
    /// There is no "active" flag — the runtime uses the most recently created
    /// web thread, or the one conversation in single-thread mode (see
    /// `find_latest_web_thread`). Channel threads (externalThreadId set) are excluded;
    /// those are resolved via `get_or_create_thread_by_external_id`. Creates a fresh
    /// thread when the user has none yet.
    pub async fn get_or_create_latest_thread(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> anyhow::Result<ConversationThread> {
        if let Some(thread) = self.find_latest_web_thread(agent_id, user_id).await? {
            return Ok(thread);
        }
        let thread = insert_thread(NewConversationThread::new(agent_id, user_id)).await?;
        log_info!(
            "Created new conversation thread for user {} (threadId: {})",
            user_id,
            thread.id
        );
        track_event(
            "thread created",
            Some(user_id),
            Some(props([
                ("agent.id", agent_id.to_string()),
                ("thread.id", thread.id.clone()),
                ("thread.source", "database".to_string()),
            ])),
        );
        self.announce_thread(&thread);
        Ok(thread)
    }

    /// The user's latest web thread, or `None` when there is none. Creates nothing.
    /// In single-thread mode it is the one conversation.
    pub async fn find_latest_web_thread(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Option<ConversationThread>> {
        if thread_mode() == ThreadMode::Single {
            return self.single_thread(agent_id, user_id).await;
        }
        self.newest_web_thread(agent_id, user_id).await
    }

    /// Say that a web thread exists, so every open client can list it — a
    /// conversation started on one device shows up on the others without a reload.
    /// Channel-agnostic, like `THREAD_TITLE_SERVICE`: transports subscribe.
    fn announce_thread(&self, thread: &ConversationThread) {
        self.events.emit_thread(&ThreadCreated {
            user_id: thread.user_id.clone(),
            thread_id: thread.id.clone(),
            title: thread.title.clone(),
            created_at: thread.created_at,
        });
    }

    /// Create a brand-new database conversation thread. Used when the CLI opens or
    /// a session resets so the conversation starts fresh — the newly created thread
    /// becomes the latest (see `get_or_create_latest_thread`), so no archiving is needed.
    ///
    /// `options.workspace_root` optionally records the working directory this
    /// conversation is rooted in (e.g. the CLI's launch cwd). It's persisted once
    /// here and never changed; shell tools later use it as their cwd. Empty /
    /// whitespace-only values are ignored.
    ///
    /// In single-thread mode it creates nothing and returns the one conversation,
    /// whose workspace root stays the one it was created with.
    pub async fn start_new_thread(
        &self,
        agent_id: &str,
        user_id: &str,
        options: Option<StartThreadOptions>,
    ) -> anyhow::Result<ConversationThread> {
        if thread_mode() == ThreadMode::Single {
            return self.get_or_create_latest_thread(agent_id, user_id).await;
        }
        let workspace_root = options
            .and_then(|options| options.workspace_root)
            .map(|root| js::trim(&root).to_string())
            .filter(|root| !root.is_empty());
        let mut row = NewConversationThread::new(agent_id, user_id);
        row.workspace_root = workspace_root;
        let thread = insert_thread(row).await?;
        log_info!(
            "Started new conversation thread for user {} (threadId: {})",
            user_id,
            thread.id
        );
        track_event(
            "thread created",
            Some(user_id),
            Some(props([
                ("agent.id", agent_id.to_string()),
                ("thread.id", thread.id.clone()),
                ("thread.source", "database".to_string()),
            ])),
        );
        self.announce_thread(&thread);
        Ok(thread)
    }

    /// Start a fresh conversation, reusing the newest thread when it is still
    /// untouched (zero messages) so repeated "new conversation" clicks don't pile
    /// up empty threads. Threads rooted in a workspace are never reused — the CLI
    /// creates one (with a workspaceRoot) on every launch, and handing that
    /// session's thread to the web would make them share it.
    ///
    /// In single-thread mode it returns the one conversation.
    pub async fn get_or_create_fresh_thread(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> anyhow::Result<ConversationThread> {
        if thread_mode() == ThreadMode::Single {
            return self.get_or_create_latest_thread(agent_id, user_id).await;
        }
        let (agent, user) = (agent_id.to_string(), user_id.to_string());
        let newest = crate::db::run(move |conn| {
            Ok(t::conversation_threads
                .filter(t::agent_id.eq(agent))
                .filter(t::user_id.eq(user))
                .filter(web_thread())
                .order(t::created_at.desc())
                .select(ConversationThread::as_select())
                .first(conn)
                .optional()?)
        })
        .await?;

        if let Some(newest) = newest.filter(|thread| {
            thread
                .workspace_root
                .as_deref()
                .is_none_or(|root| root.is_empty())
        }) {
            let id = newest.id.clone();
            let message_count: i64 = crate::db::run(move |conn| {
                Ok(m::conversation_messages
                    .filter(m::thread_id.eq(id))
                    .count()
                    .get_result(conn)?)
            })
            .await?;
            if message_count == 0 {
                return Ok(newest);
            }
        }

        self.start_new_thread(agent_id, user_id, None).await
    }

    /// Read a thread's persisted workspace root (the directory it's rooted in),
    /// or `None` if unset. Used by the conversation engine to scope shell tools to
    /// the thread's workspace when one was recorded at creation.
    pub async fn get_thread_workspace_root(
        &self,
        thread_id: &str,
    ) -> anyhow::Result<Option<String>> {
        let id = thread_id.to_string();
        let root = crate::db::run(move |conn| {
            Ok(t::conversation_threads
                .filter(t::id.eq(id))
                .select(t::workspace_root)
                .first::<Option<String>>(conn)
                .optional()?)
        })
        .await?;
        Ok(root.flatten())
    }

    /// Get or create a conversation thread bound to a specific external thread ID,
    /// for a channel where each of its threads maps to its own conversation.
    /// `live` marks a thread whose history the channel keeps: it is read through
    /// the provider registered for `live.source`.
    pub async fn get_or_create_thread_by_external_id(
        &self,
        user_id: &str,
        agent_id: &str,
        external_thread_id: &str,
        live: Option<LiveThread>,
    ) -> anyhow::Result<ConversationThread> {
        let (agent, user, external) = (
            agent_id.to_string(),
            user_id.to_string(),
            external_thread_id.to_string(),
        );
        let live_fields = live.clone();
        let thread = crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let existing = t::conversation_threads
                    .filter(t::agent_id.eq(&agent))
                    .filter(t::user_id.eq(&user))
                    .filter(t::external_thread_id.eq(&external))
                    .select(t::id)
                    .first::<String>(conn)
                    .optional()?;
                if let Some(id) = existing {
                    // Update the channel id if provided (in case it was missing before).
                    let mut changes = ConversationThreadChangeset::default();
                    if let Some(live) = &live_fields {
                        changes.thread_source = Some(live.source);
                        changes.external_channel_id = Some(Some(live.channel_id.clone()));
                    }
                    return Ok(diesel::update(t::conversation_threads.filter(t::id.eq(id)))
                        .set(&changes)
                        .returning(ConversationThread::as_returning())
                        .get_result(conn)?);
                }
                let mut row = NewConversationThread::new(agent.clone(), user.clone());
                row.external_thread_id = Some(external.clone());
                if let Some(live) = &live_fields {
                    row.thread_source = live.source;
                    row.external_channel_id = Some(live.channel_id.clone());
                }
                Ok(diesel::insert_into(t::conversation_threads)
                    .values(&row)
                    .returning(ConversationThread::as_returning())
                    .get_result(conn)?)
            })
        })
        .await?;

        // An upsert can't report create-vs-update; on create both timestamps carry
        // the same initial value, while the update path bumps updatedAt.
        if thread.created_at.timestamp_millis() == thread.updated_at.timestamp_millis() {
            let source = live.map_or(ThreadSource::Database, |live| live.source);
            track_event(
                "thread created",
                Some(user_id),
                Some(props([
                    ("agent.id", agent_id.to_string()),
                    ("thread.id", thread.id.clone()),
                    ("thread.source", source.as_str().to_lowercase()),
                ])),
            );
        }

        Ok(thread)
    }

    /// The thread bound to an external thread ID, without creating one.
    pub async fn find_thread_by_external_id(
        &self,
        user_id: &str,
        agent_id: &str,
        external_thread_id: &str,
    ) -> anyhow::Result<Option<ConversationThread>> {
        let (agent, user, external) = (
            agent_id.to_string(),
            user_id.to_string(),
            external_thread_id.to_string(),
        );
        crate::db::run(move |conn| {
            Ok(t::conversation_threads
                .filter(t::agent_id.eq(agent))
                .filter(t::user_id.eq(user))
                .filter(t::external_thread_id.eq(external))
                .select(ConversationThread::as_select())
                .first(conn)
                .optional()?)
        })
        .await
    }

    /// The web thread `thread_id` when it belongs to the agent and the user and a
    /// client may see it.
    async fn client_thread(
        &self,
        user_id: &str,
        agent_id: &str,
        thread_id: &str,
    ) -> anyhow::Result<Option<ConversationThread>> {
        let filter = self.client_thread_filter(agent_id, user_id).await?;
        let (id, agent, user) = (
            thread_id.to_string(),
            agent_id.to_string(),
            user_id.to_string(),
        );
        crate::db::run(move |conn| {
            let query = t::conversation_threads
                .filter(t::id.eq(id))
                .filter(t::agent_id.eq(agent))
                .filter(t::user_id.eq(user))
                .filter(web_thread())
                .into_boxed();
            Ok(client_threads(query, &filter)
                .select(ConversationThread::as_select())
                .first(conn)
                .optional()?)
        })
        .await
    }

    /// Get a web thread by ID (with ownership check). With `page`, it holds that page of
    /// messages instead of the whole history.
    pub async fn get_thread(
        &self,
        user_id: &str,
        agent_id: &str,
        thread_id: &str,
        page: Option<MessagePage>,
    ) -> anyhow::Result<Option<ThreadWithMessages>> {
        let Some(thread) = self.client_thread(user_id, agent_id, thread_id).await? else {
            return Ok(None);
        };

        let provider = Arc::clone(&self.database_provider);

        // CLIENT history (web SPA): hide concise-mode internal steps. The model path
        // (get_thread_context) reads without this option so it still replays them.
        let read = match page {
            Some(page) => {
                provider
                    .get_recent_messages(
                        thread_id,
                        page.limit,
                        Some(&MessageReadOptions {
                            view: Some(MessageView::Client),
                            before: page.before,
                        }),
                    )
                    .await?
            }
            None => {
                provider
                    .get_messages(
                        thread_id,
                        Some(&MessageReadOptions {
                            view: Some(MessageView::Client),
                            before: None,
                        }),
                    )
                    .await?
            }
        };
        let messages = self.with_hidden_step_tool_calls(thread_id, read).await?;

        // Attach file metadata (no bytes) so the web UI renders chips on history.
        let with_attachments = ATTACHMENT_SERVICE.attach_meta_to_messages(messages).await?;

        // Derived here rather than in each client: the percentage needs the model's
        // context window, which only the runtime has. `None` until the thread's
        // first turn completes, or when the stored model is unrecognized.
        let context_usage = build_context_snapshot(
            thread_id,
            thread.context_model.as_deref(),
            thread.context_tokens,
        );

        Ok(Some(ThreadWithMessages {
            thread,
            messages: with_attachments.into_iter().map(with_sender).collect(),
            context_usage,
        }))
    }

    /// Lightweight ownership/existence check: returns the thread id when it is a web
    /// thread of this agent+user, else `None`. Unlike `get_thread` it does NOT load
    /// the thread's messages or attachment metadata, so callers that only need to
    /// authorize a thread id (e.g. the CLI's /messages replay) stay cheap.
    pub async fn get_owned_thread_id(
        &self,
        user_id: &str,
        agent_id: &str,
        thread_id: &str,
    ) -> anyhow::Result<Option<String>> {
        Ok(self
            .client_thread(user_id, agent_id, thread_id)
            .await?
            .map(|thread| thread.id))
    }

    /// List the threads of a user, newest first. With `workspace_root`, only the
    /// threads rooted in that folder, so the limit counts those alone.
    ///
    /// The DATABASE set is the web/CLI-resumable one. Genuine web/CLI threads are
    /// always created with externalThreadId: null; externalId-keyed DATABASE threads
    /// (a channel's top-level DM, keyed by its conversation id) are conversation
    /// records, not resumable threads, so listing DATABASE threads excludes them.
    pub async fn list_threads(
        &self,
        user_id: &str,
        agent_id: &str,
        options: Option<ListThreadsOptions>,
    ) -> anyhow::Result<Vec<ConversationThread>> {
        let filter = self.client_thread_filter(agent_id, user_id).await?;
        let options = options.unwrap_or_default();
        let (agent, user) = (agent_id.to_string(), user_id.to_string());
        crate::db::run(move |conn| {
            let mut query = client_threads(
                t::conversation_threads
                    .filter(t::agent_id.eq(agent))
                    .filter(t::user_id.eq(user))
                    .into_boxed(),
                &filter,
            );
            if let Some(root) = options.workspace_root {
                query = query.filter(t::workspace_root.eq(root));
            }
            match options.thread_source {
                Some(ThreadSource::Database) => query = query.filter(web_thread()),
                Some(source) => query = query.filter(t::thread_source.eq(source)),
                None => {}
            }
            Ok(query
                .order(t::created_at.desc())
                .limit(options.limit.unwrap_or(20))
                .select(ConversationThread::as_select())
                .load(conn)?)
        })
        .await
    }

    /// Add a message to a thread.
    ///
    /// Returns the created message plus `title_set` — the title just assigned to
    /// the thread from this (first user) message, or `None` when no title was set
    /// (non-USER, empty content, or the thread is already titled). Callers use it
    /// to push a live title update to clients. An internal row never names the
    /// thread.
    pub async fn add_message(
        &self,
        thread_id: &str,
        input: MessageInput,
    ) -> anyhow::Result<AddedMessage> {
        Ok(self.add_message_with(thread_id, input, |_| Ok(())).await?.0)
    }

    /// `add_message`, with `with_message`: a write that commits with the new row, or
    /// not at all. Answers what that write answered.
    pub async fn add_message_with<T: Send + 'static>(
        &self,
        thread_id: &str,
        input: MessageInput,
        with_message: impl FnOnce(&mut SqliteConnection) -> anyhow::Result<T> + Send + 'static,
    ) -> anyhow::Result<(AddedMessage, T)> {
        let row = message_row(thread_id, &input);
        let (message, written) = crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let created = diesel::insert_into(m::conversation_messages)
                    .values(&row)
                    .returning(ConversationMessage::as_returning())
                    .get_result(conn)?;
                Ok((created, with_message(conn)?))
            })
        })
        .await?;

        // Update the thread's updatedAt.
        let id = thread_id.to_string();
        let (agent_id, user_id) = crate::db::run(move |conn| {
            let owner = diesel::update(t::conversation_threads.filter(t::id.eq(id)))
                .set(t::updated_at.eq(DbDateTime::now()))
                .returning((t::agent_id, t::user_id))
                .get_result::<(String, String)>(conn)
                .optional()?;
            owner.ok_or_else(record_not_found)
        })
        .await?;

        track_message_added(&agent_id, thread_id, &input);
        self.events.emit_message(&MessageStored {
            user_id,
            agent_id,
            thread_id: thread_id.to_string(),
            triggered_by: input.triggered_by,
        });
        let title_set = self.title_from_first_message(thread_id, &input).await?;
        Ok((AddedMessage { message, title_set }, written))
    }

    /// Add several messages to a thread in one transaction, so either all of
    /// them are stored or none is. The rows keep the given order: each is dated a
    /// millisecond after the one before it, and the last a millisecond before
    /// now. `replacing` names rows of the thread the inputs write again, which the
    /// same transaction deletes.
    pub async fn add_messages(
        &self,
        thread_id: &str,
        inputs: Vec<MessageInput>,
        replacing: Vec<String>,
    ) -> anyhow::Result<()> {
        let Some(last) = inputs.last() else {
            return Ok(());
        };
        let now = Utc::now();
        let count = inputs.len() as i64;
        let rows: Vec<NewConversationMessage> = inputs
            .iter()
            .enumerate()
            .map(|(index, input)| {
                let mut row = message_row(thread_id, input);
                row.created_at =
                    (now - chrono::Duration::milliseconds(count - index as i64)).into();
                row
            })
            .collect();
        let id = thread_id.to_string();
        let (agent_id, user_id) = crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let owner = diesel::update(t::conversation_threads.filter(t::id.eq(&id)))
                    .set(t::updated_at.eq(DbDateTime::from(now)))
                    .returning((t::agent_id, t::user_id))
                    .get_result::<(String, String)>(conn)
                    .optional()?
                    .ok_or_else(record_not_found)?;
                if !replacing.is_empty() {
                    diesel::delete(
                        m::conversation_messages
                            .filter(m::thread_id.eq(&id))
                            .filter(m::id.eq_any(&replacing)),
                    )
                    .execute(conn)?;
                }
                for row in &rows {
                    diesel::insert_into(m::conversation_messages)
                        .values(row)
                        .execute(conn)?;
                }
                Ok(owner)
            })
        })
        .await?;
        for input in &inputs {
            track_message_added(&agent_id, thread_id, input);
        }
        // One event for the batch: listeners (compaction) look at the thread, not the row.
        self.events.emit_message(&MessageStored {
            user_id,
            agent_id,
            thread_id: thread_id.to_string(),
            triggered_by: last.triggered_by,
        });
        let titled = inputs.iter().find(|input| {
            input.role == MessageRole::User
                && !input.internal_step.unwrap_or(false)
                && !derive_thread_title(&input.content).is_empty()
        });
        if let Some(titled) = titled {
            self.title_from_first_message(thread_id, titled).await?;
        }
        Ok(())
    }

    /// Name the thread after the user's first message (first 3 words, capped).
    /// Returns the title when this message set it.
    async fn title_from_first_message(
        &self,
        thread_id: &str,
        input: &MessageInput,
    ) -> anyhow::Result<Option<String>> {
        // `title IS NULL` makes this atomic and one-shot — it fires only for the very
        // first user message with text and is a no-op for every later message.
        // A changed row means this call actually set it, so callers can broadcast it.
        // Never from an internal row: those are written for model context and are not
        // the user's words. A first message carrying only a file leaves the title unset
        // (its text is empty), and the turn's recalled memories would otherwise be the
        // next USER row with text and name the thread after themselves.
        let mut title_set = None;
        if input.role == MessageRole::User && !input.internal_step.unwrap_or(false) {
            let title = derive_thread_title(&input.content);
            if !title.is_empty() {
                let (id, new_title) = (thread_id.to_string(), title.clone());
                let count = crate::db::run(move |conn| {
                    Ok(diesel::update(
                        t::conversation_threads
                            .filter(t::id.eq(id))
                            .filter(t::title.is_null()),
                    )
                    .set((
                        t::title.eq(Some(new_title)),
                        t::updated_at.eq(DbDateTime::now()),
                    ))
                    .execute(conn)?)
                })
                .await?;
                if count > 0 {
                    title_set = Some(title);
                }
            }
        }
        Ok(title_set)
    }

    /// Store the external message ID on a persisted message: the id the channel
    /// gave the posted copy. Links DB records back to channel messages for tool
    /// call enrichment.
    pub async fn set_external_message_id(
        &self,
        message_id: &str,
        external_message_id: &str,
    ) -> anyhow::Result<()> {
        let (id, external) = (message_id.to_string(), external_message_id.to_string());
        let count = crate::db::run(move |conn| {
            Ok(
                diesel::update(m::conversation_messages.filter(m::id.eq(id)))
                    .set(m::external_message_id.eq(Some(external)))
                    .execute(conn)?,
            )
        })
        .await?;
        if count == 0 {
            return Err(record_not_found());
        }
        Ok(())
    }

    /// Get recent messages from a thread for CLIENT history (`GET /messages`): the
    /// newest `limit` (callers default to 20), or the `limit` before the message
    /// `before`. Hides concise-mode internal steps — the model path uses
    /// `get_thread_context`.
    pub async fn get_recent_messages(
        &self,
        thread_id: &str,
        limit: i64,
        before: Option<&str>,
    ) -> anyhow::Result<Vec<WithSender<ConversationMessage>>> {
        let provider = self.resolve_provider(thread_id).await?;
        let messages = provider
            .get_recent_messages(
                thread_id,
                limit,
                Some(&MessageReadOptions {
                    view: Some(MessageView::Client),
                    before: before.map(str::to_string),
                }),
            )
            .await?;
        Ok(self
            .with_hidden_step_tool_calls(thread_id, messages)
            .await?
            .into_iter()
            .map(with_sender)
            .collect())
    }

    /// Whether two or more people wrote in the thread. Every row counts, compacted
    /// ones too, and no row is deleted, so once true it stays true.
    pub async fn has_several_senders(&self, thread_id: &str) -> anyhow::Result<bool> {
        let id = thread_id.to_string();
        let senders = crate::db::run(move |conn| {
            Ok(m::conversation_messages
                .filter(m::thread_id.eq(id))
                .filter(m::role.eq(MessageRole::User))
                .filter(m::triggered_by.eq(MessageTrigger::UserInput))
                .filter(m::sender_external_id.is_not_null())
                .select(m::sender_external_id)
                .distinct()
                .limit(2)
                .load::<Option<String>>(conn)?)
        })
        .await?;
        Ok(senders.len() > 1)
    }

    /// The oldest message of a stored thread, internal steps left out: in a channel
    /// thread, the first one the agent saw.
    pub async fn get_first_message(
        &self,
        thread_id: &str,
    ) -> anyhow::Result<Option<ConversationMessage>> {
        let id = thread_id.to_string();
        crate::db::run(move |conn| {
            Ok(m::conversation_messages
                .filter(m::thread_id.eq(id))
                .filter(m::internal_step.eq(false))
                .order((m::created_at.asc(), m::id.asc()))
                .select(ConversationMessage::as_select())
                .first(conn)
                .optional()?)
        })
        .await
    }

    /// The messages a client is shown, each agent message with the tool calls of
    /// the concise-mode steps its turn hid, ahead of its own. A client acts on some
    /// results, such as an MCP tool that asks the person for something, and a
    /// concise turn shows it the answer alone. Only the copies change: the model
    /// replays each call once, from its own step. Live delivery and history read
    /// the same rows, so a reload shows what the live reply showed.
    ///
    /// A hidden step is shown on the first message at or after it that answers a
    /// person, passing over one nobody asked for, such as a heartbeat's. When the
    /// person's own message comes first, the step is shown nowhere: that keeps a
    /// cancelled turn's calls off the next answer. Another agent's message asks like
    /// a person's, so it counts the same. A message sent to steer a running turn is
    /// a person's message too, so the steps before it are not shown either: the
    /// rarer case, traded for not telling the two apart.
    pub async fn with_hidden_step_tool_calls(
        &self,
        thread_id: &str,
        messages: Vec<ConversationMessage>,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        const ASKING: [MessageTrigger; 2] =
            [MessageTrigger::UserInput, MessageTrigger::AgentMessage];
        let mut visible: Vec<&ConversationMessage> = messages.iter().collect();
        visible.sort_by(|a, b| {
            a.created_at
                .timestamp_millis()
                .cmp(&b.created_at.timestamp_millis())
                .then_with(|| a.id.cmp(&b.id))
        });
        let (Some(first), Some(last)) = (visible.first(), visible.last()) else {
            return Ok(messages);
        };
        if !visible
            .iter()
            .any(|message| message.role == MessageRole::Agent)
        {
            return Ok(messages);
        }
        let (first_at, last_at) = (first.created_at, last.created_at);

        // The window starts at the last row before the first message that a person sent
        // or that answers one. A step before that row is shown on it or nowhere. A step
        // after it can belong to an answer here, even past a heartbeat's row, so a page
        // shows what the whole history shows.
        let id = thread_id.to_string();
        let before = crate::db::run(move |conn| {
            Ok(m::conversation_messages
                .filter(m::thread_id.eq(id))
                .filter(m::internal_step.eq(false))
                .filter(m::triggered_by.eq_any(ASKING))
                .filter(m::created_at.lt(DbDateTime(first_at)))
                .order((m::created_at.desc(), m::id.desc()))
                .select(m::created_at)
                .first::<DateTime<Utc>>(conn)
                .optional()?)
        })
        .await?;
        let id = thread_id.to_string();
        let steps = crate::db::run(move |conn| {
            let mut query = m::conversation_messages
                .filter(m::thread_id.eq(id))
                .filter(m::role.eq(MessageRole::Agent))
                .filter(m::internal_step.eq(true))
                .filter(m::created_at.le(DbDateTime(last_at)))
                .into_boxed();
            if let Some(before) = before {
                query = query.filter(m::created_at.gt(DbDateTime(before)));
            }
            Ok(query
                .order((m::created_at.asc(), m::id.asc()))
                .select((m::created_at, m::tool_calls))
                .load::<(DateTime<Utc>, Option<Value>)>(conn)?)
        })
        .await?;

        let mut hidden: HashMap<String, Vec<Value>> = HashMap::new();
        for (created_at, tool_calls) in steps {
            let Some(Value::Array(calls)) = tool_calls else {
                continue;
            };
            if calls.is_empty() {
                continue;
            }
            let shown_on = visible.iter().find(|message| {
                ASKING.contains(&message.triggered_by)
                    && message.created_at.timestamp_millis() >= created_at.timestamp_millis()
            });
            let Some(shown_on) = shown_on.filter(|message| message.role == MessageRole::Agent)
            else {
                continue;
            };
            hidden.entry(shown_on.id.clone()).or_default().extend(calls);
        }
        if hidden.is_empty() {
            return Ok(messages);
        }
        Ok(messages
            .into_iter()
            .map(|mut message| {
                let Some(mut calls) = hidden.remove(&message.id) else {
                    return message;
                };
                if let Some(Value::Array(own)) = message.tool_calls.take() {
                    calls.extend(own);
                }
                message.tool_calls = Some(Value::Array(calls));
                message
            })
            .collect())
    }

    /// Record this thread's latest context-occupancy snapshot.
    ///
    /// `context_tokens` is a per-turn measurement (the provider-reported prompt size
    /// plus that turn's output), NOT a running total — each call overwrites the
    /// previous value. `context_model` is stored alongside so the percentage is
    /// recomputed against the right window even after the agent's model changes.
    ///
    /// A thread deleted mid-turn is a silent no-op, matching `update_thread_title`.
    pub async fn set_thread_context_usage(
        &self,
        thread_id: &str,
        context_tokens: i64,
        context_model: &str,
    ) -> anyhow::Result<()> {
        let id = thread_id.to_string();
        let changes = ConversationThreadChangeset {
            context_tokens: Some(Some(context_tokens)),
            context_model: Some(Some(context_model.to_string())),
            ..ConversationThreadChangeset::default()
        };
        crate::db::run(move |conn| {
            diesel::update(t::conversation_threads.filter(t::id.eq(id)))
                .set(&changes)
                .execute(conn)?;
            Ok(())
        })
        .await
    }

    /// The thread's latest context measurement in tokens, or `None` when it has none.
    pub async fn get_thread_context_tokens(&self, thread_id: &str) -> anyhow::Result<Option<i64>> {
        let id = thread_id.to_string();
        let tokens = crate::db::run(move |conn| {
            Ok(t::conversation_threads
                .filter(t::id.eq(id))
                .select(t::context_tokens)
                .first::<Option<i64>>(conn)
                .optional()?)
        })
        .await?;
        Ok(tokens.flatten())
    }

    /// Update thread title.
    pub async fn update_thread_title(
        &self,
        agent_id: &str,
        user_id: &str,
        thread_id: &str,
        title: &str,
    ) -> anyhow::Result<()> {
        let (id, agent, user) = (
            thread_id.to_string(),
            agent_id.to_string(),
            user_id.to_string(),
        );
        let changes = ConversationThreadChangeset {
            title: Some(Some(title.to_string())),
            ..ConversationThreadChangeset::default()
        };
        crate::db::run(move |conn| {
            diesel::update(
                t::conversation_threads
                    .filter(t::id.eq(id))
                    .filter(t::agent_id.eq(agent))
                    .filter(t::user_id.eq(user)),
            )
            .set(&changes)
            .execute(conn)?;
            Ok(())
        })
        .await
    }

    /// Get thread with compaction summary (for context building).
    /// Compaction itself (summarize + mark rows) lives in `compaction_service.rs`.
    pub async fn get_thread_context(&self, thread_id: &str) -> anyhow::Result<StoredThreadContext> {
        let id = thread_id.to_string();
        let thread = crate::db::run(move |conn| {
            Ok(t::conversation_threads
                .filter(t::id.eq(id))
                .select((t::compaction_summary, t::thread_source))
                .first::<(Option<String>, ThreadSource)>(conn)
                .optional()?)
        })
        .await?;

        let thread_source = thread
            .as_ref()
            .map_or(ThreadSource::Database, |(_, source)| *source);
        let messages = self
            .provider_for(Some(thread_source))
            .get_messages(thread_id, None)
            .await?;
        // A channel keeps this history, so the search keeps a copy of its person messages.
        if thread_source != ThreadSource::Database
            && let Err(error) = CONVERSATION_SEARCH_SERVICE
                .record_channel_messages(thread_id, &messages)
                .await
        {
            log_warn!(
                json!({ "threadId": thread_id, "err": err_json(&error) }),
                "[ConversationService] could not keep the channel's messages for search"
            );
        }

        Ok(StoredThreadContext {
            compaction_summary: thread.and_then(|(summary, _)| summary),
            thread_source,
            messages,
        })
    }

    /// The threads idle compaction may have to finish after a restart: large, and used since `since`.
    pub async fn list_idle_compaction_candidates(
        &self,
        min_tokens: i64,
        since: DateTime<Utc>,
    ) -> anyhow::Result<Vec<IdleCompactionCandidate>> {
        let rows = crate::db::run(move |conn| {
            Ok(t::conversation_threads
                .filter(t::context_tokens.ge(Some(min_tokens)))
                .filter(t::updated_at.ge(DbDateTime(since)))
                .select((t::id, t::agent_id, t::user_id, t::compacted_at))
                .load::<(String, String, String, Option<DateTime<Utc>>)>(conn)?)
        })
        .await?;
        Ok(rows
            .into_iter()
            .map(
                |(id, agent_id, user_id, compacted_at)| IdleCompactionCandidate {
                    id,
                    agent_id,
                    user_id,
                    compacted_at,
                },
            )
            .collect())
    }

    /// Set the external thread ID on an existing thread.
    /// Used to link an internal thread to an external channel thread.
    /// Always overwrites any existing external ID — the latest channel thread wins.
    pub async fn set_external_id(
        &self,
        thread_id: &str,
        external_thread_id: &str,
    ) -> anyhow::Result<()> {
        let id = thread_id.to_string();
        let changes = ConversationThreadChangeset {
            external_thread_id: Some(Some(external_thread_id.to_string())),
            ..ConversationThreadChangeset::default()
        };
        crate::db::run(move |conn| {
            diesel::update(t::conversation_threads.filter(t::id.eq(id)))
                .set(&changes)
                .execute(conn)?;
            Ok(())
        })
        .await?;
        let mut tracked = agent_props();
        tracked.insert("thread.id".to_string(), thread_id.to_string());
        track_event("thread external id set", None, Some(tracked));
        Ok(())
    }
}

impl Default for ConversationService {
    fn default() -> Self {
        Self::new()
    }
}

/// The error Prisma's `update` gives when no row matches.
fn record_not_found() -> anyhow::Error {
    anyhow::anyhow!(
        "An operation failed because it depends on one or more records that were required but not found. No record was found for an update."
    )
}

async fn insert_thread(row: NewConversationThread) -> anyhow::Result<ConversationThread> {
    crate::db::run(move |conn| {
        Ok(diesel::insert_into(t::conversation_threads)
            .values(&row)
            .returning(ConversationThread::as_returning())
            .get_result(conn)?)
    })
    .await
}

pub static CONVERSATION_SERVICE: LazyLock<ConversationService> =
    LazyLock::new(ConversationService::new);

/// What tests set in place of the configuration.
#[cfg(test)]
pub(crate) mod testing {
    use crate::config::ThreadMode;

    /// The thread mode the service runs in, in place of `THREAD_MODE`.
    pub(crate) static THREAD_MODE: parking_lot::Mutex<Option<ThreadMode>> =
        parking_lot::Mutex::new(None);
}

#[cfg(test)]
mod tests;
