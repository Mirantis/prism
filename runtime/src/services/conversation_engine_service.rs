//! Conversation Engine Service
//!
//! Handles chat conversations with the personal agent.
//! Invokes the LLM directly (no queue, no HTTP hop) and delivers
//! responses via the local `MessageDeliveryService`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::db::models::ConversationMessage;
use crate::lib::tool_lifecycle::ToolLifecycleListener;
use crate::prompts::context_builder::SteeringMessage;
use crate::services::channel_adapter_interface::{ChannelContext, ChannelName};
use crate::services::conversation_service::AddedMessage;
use crate::services::thread_turn_service::PendingMessage;
use crate::types::{
    AgentMessageOrigin, HistoryReadListener, InvokeError, ResumedReply, SteeringSource,
    ToolCallRecord, UIBlock,
};

// ============================================================================
// Feedback gate tuning (channel-agnostic)
// ============================================================================

/// Per-thread cadence: prompt for feedback on the 1st user turn, then every
/// Nth user turn thereafter. Counts USER messages (one per turn), so multi-
/// step responses don't throw the rhythm off.
pub const FEEDBACK_CADENCE_N: i64 = 3;

/// The system prompt of the feedback-worthiness gate.
const FEEDBACK_GATE_PROMPT: &str = "You decide whether to ask the user to rate an agent's reply with thumbs up or down. A rating is useful only when the user can judge the substance of the reply.

Answer WORTHY for a substantive reply: an analysis, explanation, plan, code, investigation summary or recommendation, or anything else the user can find helpful or not.

Answer SKIP when a rating would be noise: a short acknowledgement (\"Done.\", \"On it.\"), a question back to the user, an error or a refusal, a trivial lookup or confirmation, or a progress update with no new conclusion.

Answer with one word: WORTHY or SKIP.";

// ============================================================================
// Turn steering
// ============================================================================

/// Aggregate of one `invoke_stream` pass, published as it streamed.
struct StreamedTurn {
    text: String,
    tool_calls: Vec<ToolCallRecord>,
    blocks: Vec<UIBlock>,
    agent_message: Option<ConversationMessage>,
    /// Set when the turn ended on an error step, whose text is the published reply.
    error: Option<InvokeError>,
    /// The model's stream ended on its own, not by an abort, so the reply is the whole answer.
    completed: bool,
}

// ============================================================================
// Types
// ============================================================================

/// The shared-channel label of a thread, read again before each turn of an exchange.
pub type ChannelLabelFor =
    Arc<dyn Fn(String) -> BoxFuture<'static, anyhow::Result<Option<String>>> + Send + Sync>;

/// Where a chat message came from and how its reply is routed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMetadata {
    /// The `name` of the adapter the message came through; the reply goes back there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<ChannelName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// The channel's own thread the message was posted in, where the reply goes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_thread_id: Option<String>,
    /// The shared channel the message was posted in, as the system prompt names
    /// it. Set only for a message in a channel that several people read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_label: Option<String>,
    /// The sender's id in the originating channel, stored as-is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_external_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_name: Option<String>,
}

/// A message the caller already stored, by `accept_user_message`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredMessage {
    pub id: String,
    pub title_set: Option<String>,
}

#[derive(Clone, Default)]
pub struct ChatInput {
    pub user_id: String,
    pub agent_id: String,
    pub message: String,
    pub thread_id: Option<String>,
    /// Ids of already-stored attachments to link to this user message.
    pub attachment_ids: Option<Vec<String>>,
    /// Per-turn runtime notices injected into the system prompt (see `InvokeRequest`).
    pub runtime_notices: Option<Vec<String>>,
    /// Cancelling this token stops the in-flight LLM generation mid-turn.
    pub abort_signal: Option<CancellationToken>,
    pub on_tool_event: Option<ToolLifecycleListener>,
    /// Only hand this message to a turn already running on its thread; never start
    /// one. When no turn is live, nothing is stored and nothing is invoked, and the
    /// response comes back with `steered: Some(false)` — for transports that keep their
    /// own queue (the WS gateway) and want to fall back to it.
    pub steer_only: Option<bool>,
    /// The message is already stored, by `accept_user_message`, and this call only
    /// runs or steers the turn for it. A transport that must confirm a message the
    /// moment it is safe — before any turn, and whatever happens to the turn — stores
    /// first and hands the row over here.
    pub stored: Option<StoredMessage>,
    /// The exchange continues one a restart interrupted. `message` is the newest message it owes an answer.
    pub resumed: Option<ResumedReply>,
    /// Set when another agent of the project sent the message. It is stored as that
    /// agent's, and the model reads it as a colleague's request. Only the runtime's
    /// own agent-message route sets it: `metadata` can come from a request body.
    pub agent_message: Option<AgentMessageOrigin>,
    /// The shared-channel label of the thread, read again before each turn of the
    /// exchange, so a follow-up turn sees a person who first wrote during the turn
    /// before it. Takes precedence over `metadata.channel_label`.
    pub channel_label_for: Option<ChannelLabelFor>,
    pub metadata: Option<ChatMetadata>,
}

/// The parts of a chat input that `accept_user_message` stores.
#[derive(Debug, Clone, Default)]
pub struct UserMessageInput {
    pub agent_id: String,
    pub user_id: String,
    pub message: String,
    pub attachment_ids: Option<Vec<String>>,
    pub metadata: Option<ChatMetadata>,
    pub agent_message: Option<AgentMessageOrigin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    pub thread_id: String,
    /// Id of the agent message this call published, when it published one. Absent
    /// when there is nothing to point at: the turn was canceled before producing
    /// output, or this message was handed to a turn already running (`steered`) and
    /// that turn publishes the reply under its own call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub content: String,
    pub tool_calls: Vec<ToolCallRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<Value>>,
    pub duration_ms: i64,
    /// The title just assigned to the thread from this message, else null.
    pub title_set: Option<String>,
    /// True when this message was handed to a turn already running on the thread
    /// rather than answered by a turn of its own — no LLM call was made here, and
    /// the reply streams out of that other turn (see `THREAD_TURN_SERVICE`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steered: Option<bool>,
}

/// How an exchange on a thread ended, emitted as `turn_ended` before the thread stops working.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurnEnd {
    pub thread_id: String,
    pub cancelled: bool,
    /// Set when the agent could not answer: the exchange ended on an error reply, or failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<InvokeError>,
}

/// The message of chat work whose row is not stored yet.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatWorkMessage {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_message: Option<AgentMessageOrigin>,
}

/// A message owed an answer, as `pending_work` holds it: where its thread is and
/// how its reply is delivered.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatWork {
    pub thread_id: String,
    pub agent_id: String,
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ChatMetadata>,
    /// The message itself until its row is stored, so the boot stores it when a
    /// restart came first. `accept_user_message` writes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<ChatWorkMessage>,
    /// The tool calls the turn has made that no stored message holds yet: a step's
    /// calls are stored with the next text step. A resumed exchange stores them
    /// before its first turn, so that turn reads them as its own tool results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsaved: Option<Vec<ToolCallRecord>>,
    /// The files the turn shared that no delivered reply holds yet: they go out with
    /// the turn's last reply. A resumed exchange's first reply delivers them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsent_attachment_ids: Option<Vec<String>>,
}

/// The attachments that chat work holds: the uploads of a message not linked yet,
/// and the files a turn shared that no reply delivered. The orphan sweep keeps them.
pub async fn attachments_held_by_chat_work() -> anyhow::Result<Vec<String>> {
    todo!()
}

/// How much of an unsaved tool call the pending-work row keeps: the newest calls, each cut.
const UNSAVED_MAX_CALLS: usize = 20;
const UNSAVED_MAX_CHARS: usize = 4_000;

fn cut(text: &str) -> String {
    if crate::support::js::len16(text) <= UNSAVED_MAX_CHARS {
        return text.to_string();
    }
    format!(
        "{}…",
        crate::support::js::slice16(text, 0, UNSAVED_MAX_CHARS)
    )
}

/// A message as a turn's prompt holds it: another agent's inside the tag that names that agent.
fn prompt_text(text: &str, origin: Option<&AgentMessageOrigin>) -> String {
    todo!()
}

/// A call's input with each long string in it cut, so it stays JSON and replays
/// with its arguments. Fails when a long input is not JSON.
fn cut_input(input: &str) -> anyhow::Result<String> {
    if crate::support::js::len16(input) <= UNSAVED_MAX_CHARS {
        return Ok(input.to_string());
    }
    let parsed: Value = serde_json::from_str(input)?;
    Ok(crate::support::js::stringify(&cut_strings(parsed)))
}

fn cut_strings(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(cut(&text)),
        Value::Array(items) => Value::Array(items.into_iter().map(cut_strings).collect()),
        Value::Object(entries) => Value::Object(
            entries
                .into_iter()
                .map(|(key, field)| (key, cut_strings(field)))
                .collect(),
        ),
        other => other,
    }
}

/// After each step: the tool calls no stored message holds yet, and the files no
/// delivered reply holds yet.
type OnUnsaved = Arc<dyn Fn(Vec<ToolCallRecord>, Vec<String>) + Send + Sync>;

/// One model invocation of an exchange.
struct StreamTurnParams {
    user_id: String,
    agent_id: String,
    thread_id: String,
    workspace_root: Option<String>,
    /// The user text this turn answers; also the feedback gate's input.
    prompt: String,
    /// Restate `prompt` as the trailing user message (coalesced follow-up).
    append_prompt: bool,
    /// The turn answers the person, not only other agents, so the person may rate it.
    from_person: bool,
    appended_message_ids: Vec<String>,
    /// Snapshot taken once inside the lock; gates intermediate delivery.
    verbose: bool,
    channel_context: Option<ChannelContext>,
    metadata: Option<ChatMetadata>,
    runtime_notices: Option<Vec<String>>,
    abort_signal: Option<CancellationToken>,
    on_tool_event: Option<ToolLifecycleListener>,
    on_unsaved: OnUnsaved,
    /// Files an interrupted turn shared, which this turn's reply delivers.
    unsent_attachment_ids: Option<Vec<String>>,
    /// Drained at every step boundary, so a message handed to the turn reaches
    /// the model on the next step.
    steering: SteeringSource,
    /// A handed-over message the history holds is answered from there.
    on_history_read: HistoryReadListener,
    prompt_message_id: Option<String>,
}

/// Receives each `turn_ended` event.
pub type TurnEndedListener = Arc<dyn Fn(&ChatTurnEnd) + Send + Sync>;

/// The `turn_ended` events: an exchange on a thread ended.
#[derive(Default)]
pub struct ConversationEngineEvents {
    turn_ended: RwLock<Vec<TurnEndedListener>>,
}

impl ConversationEngineEvents {
    /// Call `listener` with every exchange that ends from now on.
    pub fn on_turn_ended(&self, listener: impl Fn(&ChatTurnEnd) + Send + Sync + 'static) {
        self.turn_ended.write().push(Arc::new(listener));
    }

    /// Hand `ended` to every listener, synchronously and in subscription order.
    pub fn emit_turn_ended(&self, ended: &ChatTurnEnd) {
        let listeners = self.turn_ended.read().clone();
        for listener in listeners {
            listener(ended);
        }
    }
}

// ============================================================================
// Conversation Engine Service
// ============================================================================

pub struct ConversationEngineService {
    pub events: ConversationEngineEvents,
    /// How to stop each exchange running on a thread, whoever started it. A person
    /// can stop the agent from any client, and a turn the runtime began itself — the
    /// continuation after a computer help request — is theirs to stop too.
    cancellers: Mutex<HashMap<String, HashMap<u64, CancellationToken>>>,
    next_canceller: AtomicU64,
}

impl ConversationEngineService {
    pub fn new() -> Self {
        Self {
            events: ConversationEngineEvents::default(),
            cancellers: Mutex::new(HashMap::new()),
            next_canceller: AtomicU64::new(0),
        }
    }

    /// Stop every exchange on a thread. Answers whether there was one to stop.
    ///
    /// A turn cancelled this way does not start another for messages still waiting
    /// on it; those stay in history, as after any cancel.
    pub fn cancel(&self, thread_id: &str) -> bool {
        let running: Vec<CancellationToken> = self
            .cancellers
            .lock()
            .get(thread_id)
            .map(|set| set.values().cloned().collect())
            .unwrap_or_default();
        if running.is_empty() {
            return false;
        }
        for token in running {
            token.cancel();
        }
        true
    }

    /// Hold `token` as a way to stop an exchange on `thread_id`, under the id
    /// `unregister_canceller` takes.
    fn register_canceller(&self, thread_id: &str, token: CancellationToken) -> u64 {
        let id = self.next_canceller.fetch_add(1, Ordering::Relaxed);
        self.cancellers
            .lock()
            .entry(thread_id.to_string())
            .or_default()
            .insert(id, token);
        id
    }

    fn unregister_canceller(&self, thread_id: &str, id: u64) {
        let mut cancellers = self.cancellers.lock();
        if let Some(set) = cancellers.get_mut(thread_id) {
            set.remove(&id);
            if set.is_empty() {
                cancellers.remove(thread_id);
            }
        }
    }

    /// Single place deciding whether to ask the user for 👍/👎 feedback on the
    /// current turn. Gates run cheap→expensive; all must pass:
    ///
    /// 1. Telemetry enabled. Feedback clicks are emitted via `track_event`, which
    ///    is a no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. Showing buttons
    ///    in that state would silently drop the rating and waste a classifier call.
    /// 2. Per-thread cadence: show on the 1st user turn, then every Nth turn.
    ///    Counts the person's messages (one per turn) rather than AGENT messages
    ///    (one per text-producing step), so multi-step responses don't throw the
    ///    cadence off. Another agent's message and a hidden row the runtime wrote
    ///    for the model are not the person's. The current turn's user message has
    ///    already been stored by the caller, so `user_count` is 1 on the very
    ///    first turn — hence `(n - 1) % N == 0`.
    /// 3. Classifier judgment: the configured classification model rates
    ///    whether the reply is substantive enough that a thumbs-up/down signal
    ///    would be meaningful (see `is_response_worthy_of_feedback`). Fail-closed —
    ///    if the classifier errors out we hide the buttons and log, rather than
    ///    spamming the user with feedback prompts during a provider outage.
    ///
    /// Channel-agnostic: adapters decide whether to render the prompt.
    async fn should_show_feedback(
        &self,
        thread_id: &str,
        user_message: &str,
        terminal_text: Option<&str>,
        user_id: &str,
        agent_id: &str,
        abort_signal: Option<&CancellationToken>,
    ) -> bool {
        todo!()
    }

    /// Binary classifier: is `agent_response` a substantive reply where a user
    /// thumbs-up/down carries useful signal? Returns `false` (fail-closed) on any
    /// classifier error — a broken/unroutable classifier should not cause us to
    /// show feedback on every reply. The verdict is logged as
    /// `[Feedback:Gate] Decision: <text> (worthy=<bool>)`.
    async fn is_response_worthy_of_feedback(
        &self,
        thread_id: &str,
        user_message: &str,
        agent_response: &str,
        user_id: &str,
        agent_id: &str,
        abort_signal: Option<&CancellationToken>,
    ) -> bool {
        todo!()
    }

    /// Answer a chat message: store it, then run its exchange — the first turn and
    /// any coalesced follow-ups — on the thread, or hand it to the turn that already
    /// owns the thread (`steered`).
    pub async fn chat(&self, input: ChatInput) -> anyhow::Result<ChatResponse> {
        todo!()
    }

    /// Store an incoming user message and do the per-message side work that belongs
    /// to it whether or not it gets a turn of its own: naming a new thread, linking
    /// any uploaded files, and showing it on every client of a channel that shows
    /// the whole conversation.
    ///
    /// The one place a user message is written. The chat socket calls it directly,
    /// before any turn, so it can confirm the message the moment it is stored; every
    /// other caller reaches it through `chat()`. `id`, when given, becomes the row's
    /// id — see `MessageInput::id`.
    pub async fn accept_user_message(
        &self,
        input: &UserMessageInput,
        thread_id: &str,
        id: Option<&str>,
    ) -> anyhow::Result<AddedMessage> {
        todo!()
    }

    /// Load attachment metadata for messages handed to a running turn, so the
    /// turn can fold them in as full user turns — a screenshot shared mid-work
    /// reaches the model as a stub on the next step, exactly as it would had it
    /// been sent at the turn's start.
    ///
    /// Runs on the consumer side because `offer()` is synchronous: the ids are
    /// queued without an await, and only whoever takes them pays for the read.
    async fn load_steering(
        &self,
        pending: Vec<PendingMessage>,
    ) -> anyhow::Result<Vec<SteeringMessage>> {
        todo!()
    }

    /// Drive one model invocation to completion, publishing each text-bearing step
    /// as it arrives, and return what the whole invocation produced.
    ///
    /// "One invocation" is the unit, not the whole exchange: `invoke_stream` runs the
    /// model until it stops (up to `STEP_LIMIT` steps, plus the early-stopping
    /// summary), and this drains that stream to its end. An exchange calls this
    /// again for each coalesced follow-up.
    ///
    /// A one-step buffer lets us tag the LAST text step with the accumulated UI
    /// blocks and the feedback decision — we can't know a step was last until the
    /// next step (or the stream end) arrives.
    async fn stream_turn(&self, params: StreamTurnParams) -> anyhow::Result<StreamedTurn> {
        todo!()
    }
}

impl Default for ConversationEngineService {
    fn default() -> Self {
        Self::new()
    }
}

pub static CONVERSATION_ENGINE_SERVICE: LazyLock<ConversationEngineService> =
    LazyLock::new(ConversationEngineService::new);
