//! Conversation Service
//!
//! Manages conversation threads and messages for the personal agent.
//! Handles thread creation, message persistence, and retrieval.

use std::borrow::Borrow;
use std::collections::HashMap;
use std::ops::{Deref, DerefMut};
use std::sync::{Arc, LazyLock};

use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::models::{
    ConversationMessage, ConversationThread, MessageRole, MessageTrigger, ThreadSource,
};
use crate::lib::agent_message_kind::agent_message_kind;
use crate::lib::context_window::ContextUsageSnapshot;
use crate::protocol::chat_protocol::AgentMessageKind;
use crate::services::attachment_service::{HasMessageId, WithAttachments};
use crate::services::providers::database_thread_provider::DatabaseThreadProvider;
use crate::services::thread_provider_interface::ThreadMessageProvider;

/// A message a compaction summary replaced, and its index among the thread's
/// compacted messages, oldest first.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactedMessage {
    pub id: String,
    pub role: MessageRole,
    pub content: String,
    pub tool_calls: Option<Value>,
    pub internal_step: bool,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    pub position: i64,
}

/// One page of compacted messages, and whether more follow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactedPage {
    pub messages: Vec<CompactedMessage>,
    pub more: bool,
}

/// Which compacted messages `list_compacted_messages` reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactedListOptions {
    /// Keep the messages whose text or tool calls hold it, ignoring case.
    pub query: Option<String>,
    pub offset: i64,
    pub limit: i64,
}

const COMPACTED_SEARCH_BATCH: i64 = 200;

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

/// The `thread` events: a web thread was created.
#[derive(Default)]
pub struct ConversationEvents {
    thread: RwLock<Vec<ThreadCreatedListener>>,
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
}

// ============================================================================
// Conversation Service
// ============================================================================

pub struct ConversationService {
    /// Emits `thread` (`ThreadCreated`) when a web thread is created.
    pub events: ConversationEvents,
    database_provider: Arc<dyn ThreadMessageProvider>,
    live_providers: RwLock<HashMap<ThreadSource, Arc<dyn ThreadMessageProvider>>>,
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
        todo!()
    }

    /// Forget single-thread mode's conversation, so the next single-thread boot keeps the
    /// conversation the person wrote in last rather than the one it kept before.
    pub async fn forget_single_thread(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// The thread a run or a chat turn that names `thread_id` writes to. In single-thread
    /// mode another web thread resolves to the one conversation, so a task or goal bound
    /// to an older conversation answers where every client shows it.
    pub async fn writable_thread_id(&self, thread_id: &str) -> anyhow::Result<String> {
        todo!()
    }

    async fn newest_web_thread(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Option<ConversationThread>> {
        todo!()
    }

    /// The threads a client may list, read or write to. In single-thread mode that is
    /// the one conversation and the channel threads; every other web thread stays in
    /// the database for when the agent runs in multi-thread mode again.
    pub async fn client_thread_filter(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> anyhow::Result<ClientThreadFilter> {
        todo!()
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
        todo!()
    }

    /// Where a thread's messages are read from, or `None` for a thread that does not exist.
    pub async fn get_thread_source(&self, thread_id: &str) -> anyhow::Result<Option<ThreadSource>> {
        todo!()
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
        todo!()
    }

    /// The user's latest web thread, or `None` when there is none. Creates nothing.
    /// In single-thread mode it is the one conversation.
    pub async fn find_latest_web_thread(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Option<ConversationThread>> {
        todo!()
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
        todo!()
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
        todo!()
    }

    /// Read a thread's persisted workspace root (the directory it's rooted in),
    /// or `None` if unset. Used by the conversation engine to scope shell tools to
    /// the thread's workspace when one was recorded at creation.
    pub async fn get_thread_workspace_root(
        &self,
        thread_id: &str,
    ) -> anyhow::Result<Option<String>> {
        todo!()
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
        todo!()
    }

    /// The thread bound to an external thread ID, without creating one.
    pub async fn find_thread_by_external_id(
        &self,
        user_id: &str,
        agent_id: &str,
        external_thread_id: &str,
    ) -> anyhow::Result<Option<ConversationThread>> {
        todo!()
    }

    /// Get a thread by ID (with ownership check). With `page`, it holds that page of
    /// messages instead of the whole history.
    pub async fn get_thread(
        &self,
        user_id: &str,
        agent_id: &str,
        thread_id: &str,
        page: Option<MessagePage>,
    ) -> anyhow::Result<Option<ThreadWithMessages>> {
        todo!()
    }

    /// Lightweight ownership/existence check: returns the thread id when it
    /// belongs to this agent+user, else `None`. Unlike `get_thread` it does NOT load
    /// the thread's messages or attachment metadata, so callers that only need to
    /// authorize a thread id (e.g. the CLI's /messages replay) stay cheap.
    pub async fn get_owned_thread_id(
        &self,
        user_id: &str,
        agent_id: &str,
        thread_id: &str,
    ) -> anyhow::Result<Option<String>> {
        todo!()
    }

    /// List the threads of a user, newest first.
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
        todo!()
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
        todo!()
    }

    /// Store the external message ID on a persisted message: the id the channel
    /// gave the posted copy. Links DB records back to channel messages for tool
    /// call enrichment.
    pub async fn set_external_message_id(
        &self,
        message_id: &str,
        external_message_id: &str,
    ) -> anyhow::Result<()> {
        todo!()
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
        todo!()
    }

    /// Whether two or more people wrote in the thread. Every row counts, compacted
    /// ones too, and no row is deleted, so once true it stays true.
    pub async fn has_several_senders(&self, thread_id: &str) -> anyhow::Result<bool> {
        todo!()
    }

    /// The oldest message of a stored thread, internal steps left out: in a channel
    /// thread, the first one the agent saw.
    pub async fn get_first_message(
        &self,
        thread_id: &str,
    ) -> anyhow::Result<Option<ConversationMessage>> {
        todo!()
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
        todo!()
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
        todo!()
    }

    /// The thread's latest context measurement in tokens, or `None` when it has none.
    pub async fn get_thread_context_tokens(&self, thread_id: &str) -> anyhow::Result<Option<i64>> {
        todo!()
    }

    /// Update thread title.
    pub async fn update_thread_title(
        &self,
        agent_id: &str,
        user_id: &str,
        thread_id: &str,
        title: &str,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Get thread with compaction summary (for context building).
    /// Compaction itself (summarize + mark rows) lives in `compaction_service.rs`.
    pub async fn get_thread_context(&self, thread_id: &str) -> anyhow::Result<StoredThreadContext> {
        todo!()
    }

    /// One page of the messages a compaction summary replaced, oldest first, and
    /// whether more follow. `query` keeps the messages whose text or tool calls hold
    /// it, ignoring case. Internal steps are included, since they hold tool calls.
    /// `offset` counts the messages the page skips: without a query it is the first
    /// message's position.
    ///
    /// The search reads the thread's compacted rows in batches and matches in code:
    /// the tool calls are a JSON array, which no SQL filter on SQLite searches. Each
    /// page reads from the thread's first compacted row again, which a long
    /// conversation pays for with a full read per page.
    pub async fn list_compacted_messages(
        &self,
        thread_id: &str,
        options: CompactedListOptions,
    ) -> anyhow::Result<CompactedPage> {
        todo!()
    }

    /// The compacted message at `position`, or `None` past the last one.
    pub async fn get_compacted_message(
        &self,
        thread_id: &str,
        position: i64,
    ) -> anyhow::Result<Option<CompactedMessage>> {
        todo!()
    }

    /// The threads idle compaction may have to finish after a restart: large, and used since `since`.
    pub async fn list_idle_compaction_candidates(
        &self,
        min_tokens: i64,
        since: DateTime<Utc>,
    ) -> anyhow::Result<Vec<IdleCompactionCandidate>> {
        todo!()
    }

    /// Set the external thread ID on an existing thread.
    /// Used to link an internal thread to an external channel thread.
    /// Always overwrites any existing external ID — the latest channel thread wins.
    pub async fn set_external_id(
        &self,
        thread_id: &str,
        external_thread_id: &str,
    ) -> anyhow::Result<()> {
        todo!()
    }
}

impl Default for ConversationService {
    fn default() -> Self {
        Self::new()
    }
}

/// Every key and value a stored tool call holds, as written, not as `JSON.stringify` escapes them.
fn strings_in(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) => vec![text.clone()],
        Value::Number(number) => vec![
            number
                .as_f64()
                .map(crate::support::js::number_text)
                .unwrap_or_else(|| number.to_string()),
        ],
        Value::Bool(flag) => vec![flag.to_string()],
        Value::Array(items) => items.iter().flat_map(strings_in).collect(),
        Value::Object(entries) => entries
            .iter()
            .flat_map(|(key, item)| std::iter::once(key.clone()).chain(strings_in(item)))
            .collect(),
        Value::Null => Vec::new(),
    }
}

pub static CONVERSATION_SERVICE: LazyLock<ConversationService> =
    LazyLock::new(ConversationService::new);
