//! Conversation Engine Service
//!
//! Handles chat conversations with the personal agent.
//! Invokes the LLM directly (no queue, no HTTP hop) and delivers
//! responses via the local `MessageDeliveryService`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};

use diesel::prelude::*;
use futures::future::{BoxFuture, try_join_all};
use futures::{FutureExt, StreamExt};
use indexmap::IndexMap;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::ai::{GenerateTextOptions, Instructions, ModelMessage};
use crate::db::models::{ConversationMessage, MessageRole, MessageTrigger};
use crate::db::schema::conversation_messages::dsl as m;
use crate::invoke::invoke_stream;
use crate::lib::classification::get_gate_request;
use crate::lib::log_redaction::err_json;
use crate::lib::model_call::{ModelCallMeta, call_model};
use crate::lib::spend_context::{SpendContext, SpendSource, SpendSourceKind, with_spend_context};
use crate::lib::telemetry::{is_telemetry_enabled, langfuse_telemetry, track_event};
use crate::lib::tool_lifecycle::ToolLifecycleListener;
use crate::prompts::agent_message_prompt::{agent_message_columns, render_agent_message};
use crate::prompts::context_builder::{ConversationMessage as HistoryRow, SteeringMessage};
use crate::prompts::resume_prompt::RESUMED_REPLY_NOTICE;
use crate::prompts::task_notification_prompt::TASK_NOTIFICATION_TRIGGER;
use crate::services::agent_workspace_service::AGENT_WORKSPACE_SERVICE;
use crate::services::attachment_service::ATTACHMENT_SERVICE;
use crate::services::channel_adapter_interface::{ChannelContext, ChannelName};
use crate::services::conversation_service::{AddedMessage, CONVERSATION_SERVICE, MessageInput};
use crate::services::conversation_thread_activity_service::CONVERSATION_THREAD_ACTIVITY_SERVICE;
use crate::services::inline_image_placement::{
    PlacedImages, PlacementContext, place_inline_images,
};
use crate::services::llm_call_service::LlmCallPurpose;
use crate::services::message_delivery_service::{MESSAGE_DELIVERY_SERVICE, PublishOptions};
use crate::services::pending_work_service::{PENDING_WORK_SERVICE, PendingWorkKind};
use crate::services::question_cards::question_card_schema::ASK_QUESTIONS_TOOL_NAME;
use crate::services::question_cards::question_card_service::QUESTION_CARD_SERVICE;
use crate::services::thread_title_service::THREAD_TITLE_SERVICE;
use crate::services::thread_turn_service::{PendingMessage, THREAD_TURN_SERVICE, ThreadClaim};
use crate::support::{js, now_ms};
use crate::types::{
    AgentMessageOrigin, HistoryReadListener, InvokeError, InvokeErrorType, InvokeMode,
    InvokeRequest, InvokeStep, PromptSource, ResumedReply, SteeringSource, TaskNotificationOrigin,
    ToolCallRecord, UIBlock,
};
use crate::{log_error, log_info};

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
    images: TurnImages,
}

/// How the images and files of a turn's replies were shown.
#[derive(Debug, Clone, Copy, Default)]
struct TurnImages {
    inline: usize,
    /// Image references that show no image.
    missed: usize,
    /// Files delivered under a reply rather than in its text.
    attached: usize,
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
    /// The runtime wrote this message in the person's name, so it leaves a waiting
    /// question card open. Only the runtime's own callers set it: `metadata` can
    /// come from a request body.
    pub runtime_written: bool,
    /// Set when the runtime wrote the message to report that a coding task the agent
    /// started in this conversation ended. `message` is the rendered notification,
    /// stored hidden from clients. Only `TASK_NOTIFICATION_SERVICE` sets it.
    pub task_notification: Option<TaskNotificationOrigin>,
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
    /// See `ChatInput::runtime_written`.
    pub runtime_written: bool,
    /// See `ChatInput::task_notification`.
    pub task_notification: Option<TaskNotificationOrigin>,
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
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub runtime_written: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_notification: Option<TaskNotificationOrigin>,
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

/// What `pending_work` holds from before a message is stored until the exchange
/// that answers it ends. The row holds the message, so a restart before the
/// insert lands stores it at boot.
pub fn chat_work_for(input: &UserMessageInput, thread_id: &str) -> ChatWork {
    ChatWork {
        thread_id: thread_id.to_string(),
        agent_id: input.agent_id.clone(),
        user_id: input.user_id.clone(),
        metadata: input.metadata.clone(),
        message: Some(ChatWorkMessage {
            message: input.message.clone(),
            attachment_ids: input.attachment_ids.clone(),
            agent_message: input.agent_message.clone(),
            runtime_written: input.runtime_written,
            task_notification: input.task_notification.clone(),
        }),
        ..ChatWork::default()
    }
}

/// The attachments that chat work holds: the uploads of a message not linked yet,
/// and the files a turn shared that no reply delivered. The orphan sweep keeps them.
pub async fn attachments_held_by_chat_work() -> anyhow::Result<Vec<String>> {
    let rows = PENDING_WORK_SERVICE.rows(PendingWorkKind::Chat).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| serde_json::from_value::<ChatWork>(row.payload).ok())
        .flat_map(|work| {
            work.message
                .and_then(|message| message.attachment_ids)
                .unwrap_or_default()
                .into_iter()
                .chain(work.unsent_attachment_ids.unwrap_or_default())
        })
        .collect())
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
    match origin {
        Some(origin) => render_agent_message(origin, text),
        None => text.to_string(),
    }
}

/// Who wrote the messages a turn answers: the person when any of them is theirs,
/// else other agents when any is theirs, else the runtime.
fn prompt_source_of<'a>(messages: impl IntoIterator<Item = &'a PendingMessage>) -> PromptSource {
    let messages: Vec<&PendingMessage> = messages.into_iter().collect();
    if messages
        .iter()
        .any(|m| m.agent_message.is_none() && m.task_notification.is_none())
    {
        return PromptSource::Person;
    }
    if messages.iter().any(|m| m.agent_message.is_some()) {
        PromptSource::Agent
    } else {
        PromptSource::Task
    }
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
    /// Who wrote the messages the turn answers. Only a turn that answers the person may be rated.
    prompt_source: PromptSource,
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

/// One way to stop an exchange: its abort token, and its claim, which stops
/// taking hand-overs at the stop.
struct Canceller {
    token: CancellationToken,
    claim: ThreadClaim,
}

impl Canceller {
    fn abort(&self) {
        self.token.cancel();
        self.claim.close();
    }
}

/// The messages an exchange owes an answer, and the rows its turns read.
#[derive(Default)]
struct Exchange {
    /// Every message this exchange answers. Each is owed an answer until the
    /// exchange ends, and a restart before then continues the exchange.
    owed: Vec<String>,
    /// The messages the current turn answers.
    turn_ids: Vec<String>,
    /// The rows this exchange's turns read as history, each with the files it held
    /// then. A message handed over that is among them reached the model there, so
    /// the turn answers it without injecting it again — even one offered after the
    /// read, as the chat socket does with a message it stored first. A row read
    /// before its files were linked to it has not: steering still sends those.
    read: HashMap<String, HashSet<String>>,
}

type SharedExchange = Arc<Mutex<Exchange>>;

/// Count `handed` as owed by the exchange and answered by the current turn.
fn take(exchange: &SharedExchange, handed: Vec<PendingMessage>) -> Vec<PendingMessage> {
    let mut exchange = exchange.lock();
    for message in &handed {
        exchange.owed.push(message.id.clone());
        exchange.turn_ids.push(message.id.clone());
    }
    handed
}

/// Whether the turn read `handed` as history, with every one of its files.
fn is_read(read: &HashMap<String, HashSet<String>>, handed: &PendingMessage) -> bool {
    read.get(&handed.id)
        .is_some_and(|files| handed.attachment_ids.iter().all(|id| files.contains(id)))
}

fn unread(exchange: &SharedExchange, handed: Vec<PendingMessage>) -> Vec<PendingMessage> {
    let exchange = exchange.lock();
    handed
        .into_iter()
        .filter(|message| !is_read(&exchange.read, message))
        .collect()
}

/// The chat work `pending_work` keeps, as JSON.
fn work_json(work: &ChatWork) -> Value {
    serde_json::to_value(work).expect("chat work serializes")
}

/// Kept as a turn goes on the row of the first message it answers, which stays
/// until the turn's reply is out. A restart stores what the turn did before the
/// resumed turn reads its history, and delivers the files it shared.
fn record_unsaved(work: &ChatWork, key: &str) -> OnUnsaved {
    let (work, key) = (work.clone(), key.to_string());
    Arc::new(
        move |calls: Vec<ToolCallRecord>, attachment_ids: Vec<String>| {
            let skip = calls.len().saturating_sub(UNSAVED_MAX_CALLS);
            let unsaved: Vec<ToolCallRecord> = calls
                .into_iter()
                .skip(skip)
                .map(|call| ToolCallRecord {
                    input: cut_input(&call.input).unwrap_or_else(|_| call.input.clone()),
                    output: cut(&call.output),
                    ..call
                })
                .collect();
            let mut kept = work.clone();
            if !unsaved.is_empty() {
                kept.unsaved = Some(unsaved);
            }
            if !attachment_ids.is_empty() {
                kept.unsent_attachment_ids = Some(attachment_ids);
            }
            PENDING_WORK_SERVICE.update(PendingWorkKind::Chat, &key, work_json(&kept));
        },
    )
}

/// A response with no turn of its own.
fn no_turn(
    thread_id: String,
    started: i64,
    title_set: Option<String>,
    steered: bool,
) -> ChatResponse {
    ChatResponse {
        thread_id,
        message_id: None,
        content: String::new(),
        tool_calls: Vec::new(),
        blocks: None,
        duration_ms: now_ms() - started,
        title_set,
        steered: Some(steered),
    }
}

fn blocks_json(blocks: &[UIBlock]) -> Option<Vec<Value>> {
    if blocks.is_empty() {
        return None;
    }
    Some(
        blocks
            .iter()
            .map(|block| serde_json::to_value(block).expect("a UI block serializes"))
            .collect(),
    )
}

fn non_empty<T: Clone>(items: &[T]) -> Option<Vec<T>> {
    (!items.is_empty()).then(|| items.to_vec())
}

pub struct ConversationEngineService {
    pub events: ConversationEngineEvents,
    /// How to stop each exchange running on a thread, whoever started it. A person
    /// can stop the agent from any client, and a turn the runtime began itself — the
    /// continuation after a computer help request — is theirs to stop too.
    cancellers: Mutex<HashMap<String, HashMap<u64, Canceller>>>,
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
        let cancellers = self.cancellers.lock();
        let Some(running) = cancellers.get(thread_id).filter(|set| !set.is_empty()) else {
            return false;
        };
        for canceller in running.values() {
            canceller.abort();
        }
        true
    }

    /// Hold a way to stop an exchange on `thread_id`, under the id
    /// `unregister_canceller` takes.
    fn register_canceller(&self, thread_id: &str, canceller: Canceller) -> u64 {
        let id = self.next_canceller.fetch_add(1, Ordering::Relaxed);
        self.cancellers
            .lock()
            .entry(thread_id.to_string())
            .or_default()
            .insert(id, canceller);
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
    ) -> anyhow::Result<bool> {
        if !is_telemetry_enabled() {
            return Ok(false);
        }
        let Some(terminal_text) = terminal_text.filter(|text| !text.is_empty()) else {
            return Ok(false);
        };

        let id = thread_id.to_string();
        let user_count: i64 = crate::db::run(move |conn| {
            Ok(m::conversation_messages
                .filter(m::thread_id.eq(id))
                .filter(m::role.eq(MessageRole::User))
                .filter(m::triggered_by.eq(MessageTrigger::UserInput))
                .filter(m::internal_step.eq(false))
                .count()
                .get_result(conn)?)
        })
        .await?;
        if user_count == 0 || (user_count - 1) % FEEDBACK_CADENCE_N != 0 {
            return Ok(false);
        }

        Ok(self
            .is_response_worthy_of_feedback(
                thread_id,
                user_message,
                terminal_text,
                user_id,
                agent_id,
                abort_signal,
            )
            .await)
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
        let result = async {
            let gate = get_gate_request()?;
            let mut params = GenerateTextOptions::new(gate.model);
            params.provider_options = Some(gate.provider_options);
            params.system = Some(Instructions::from(FEEDBACK_GATE_PROMPT));
            params.messages = Some(vec![ModelMessage::user(format!(
                "## User message\n{user_message}\n\n## Agent reply\n{agent_response}"
            ))]);
            // 16 is the OpenAI Responses API minimum (a cap — the verdict is one word).
            params.max_output_tokens = Some(16);
            params.temperature = gate.sampling_params.temperature;
            params.abort_signal = abort_signal.cloned();
            let identifiers: IndexMap<String, String> =
                [("userId".to_string(), user_id.to_string())]
                    .into_iter()
                    .collect();
            let telemetry = langfuse_telemetry("feedback-worthiness-gate", Some(identifiers), None);
            params.telemetry = telemetry.experimental_telemetry;
            if let Some(context) = telemetry.runtime_context {
                for (key, value) in context {
                    params.runtime_context.insert(key, Value::String(value));
                }
            }
            let mut meta = ModelCallMeta::new(LlmCallPurpose::FeedbackGate);
            meta.thread_id = Some(thread_id.to_string());
            call_model(meta, params).await
        }
        .await;
        match result {
            Ok(result) => {
                let text = result.text();
                let verdict = js::trim(&text);
                let worthy = verdict.to_uppercase().starts_with("WORTHY");
                log_info!("[Feedback:Gate] Decision: {} (worthy={})", verdict, worthy);
                worthy
            }
            Err(error) => {
                log_error!(
                    json!({ "err": err_json(&error) }),
                    "[Feedback:Gate] Gate call failed, suppressing feedback"
                );
                false
            }
        }
    }

    /// Answer a chat message: store it, then run its exchange — the first turn and
    /// any coalesced follow-ups — on the thread, or hand it to the turn that already
    /// owns the thread (`steered`).
    pub async fn chat(&self, input: ChatInput) -> anyhow::Result<ChatResponse> {
        let start_time = now_ms();
        let agent_id = input.agent_id.clone();
        let user_id = input.user_id.clone();
        let message = input.message.clone();
        let metadata = input.metadata.clone();
        let agent_origin = input.agent_message.clone();

        // Get or create the thread, capturing its persisted workspace root so shell
        // tools run with the thread's cwd (falling back to the global root when
        // unset — see resolve_workspace).
        let requested = input.thread_id.clone().filter(|id| !id.is_empty());
        let (thread_id, workspace_root) = match requested {
            Some(requested) => {
                let thread_id = CONVERSATION_SERVICE.writable_thread_id(&requested).await?;
                let root = CONVERSATION_SERVICE
                    .get_thread_workspace_root(&thread_id)
                    .await?;
                (thread_id, root)
            }
            None => {
                let thread = CONVERSATION_SERVICE
                    .get_or_create_latest_thread(&agent_id, &user_id)
                    .await?;
                (thread.id, thread.workspace_root)
            }
        };

        // A turn may already own this thread — the user sent this while the agent was
        // working. Hand it over instead of starting a second turn: that turn picks
        // the message up at its next step boundary, so the user can redirect work in
        // flight. Queuing a turn of its own would instead leave the history ending on
        // the running turn's replies, which the provider rejects as assistant prefill
        // (see thread_turn_service.rs).
        //
        // Otherwise this call takes the thread, and does so here — synchronously,
        // before it stores anything or waits for the mutex. Hand-over and claim are
        // one act, so a message arriving during our own setup finds the thread taken
        // and is handed to us instead of starting a turn that would race us. Files
        // travel as ids: whoever takes the message loads their bytes on its own side.
        //
        // Transports with their own queue (the WS gateway) ask steer-only: hand over
        // to a turn that owns the thread, but never take the thread themselves. When
        // nothing owns it, nothing is stored and nothing is invoked, so they queue the
        // message exactly as before.
        // Held as one value so a failed store can name it again and withdraw it. The
        // id is chosen now, before the store, because a hand-over happens first.
        let message_id = input
            .stored
            .as_ref()
            .map_or_else(|| Uuid::new_v4().to_string(), |stored| stored.id.clone());
        let pending = PendingMessage {
            id: message_id.clone(),
            text: message.clone(),
            attachment_ids: input.attachment_ids.clone().unwrap_or_default(),
            agent_message: agent_origin.clone(),
            task_notification: input.task_notification.clone(),
        };
        let steer_only = input.steer_only == Some(true);
        // A reply a restart interrupted is never handed over: what its exchange stores
        // and delivers first belongs to that exchange alone, so it waits for the thread.
        let claim = if steer_only {
            None
        } else if input.resumed.is_some() {
            Some(THREAD_TURN_SERVICE.claim_when_free(&thread_id).await)
        } else {
            THREAD_TURN_SERVICE.claim_or_offer(&thread_id, pending.clone())
        };

        if steer_only
            && (input.resumed.is_some() || !THREAD_TURN_SERVICE.offer(&thread_id, pending.clone()))
        {
            return Ok(no_turn(
                thread_id,
                start_time,
                input
                    .stored
                    .as_ref()
                    .and_then(|stored| stored.title_set.clone()),
                false,
            ));
        }

        // Store the message now rather than after taking the mutex, so its row keeps
        // its arrival order relative to messages handed to other turns. On the owning
        // path the wait lands inside `claim.run()`, where a failed write releases the
        // thread instead of leaving it taken forever. A message the caller already
        // stored is not written again.
        let stored: JoinHandle<anyhow::Result<Option<String>>> = match &input.stored {
            Some(stored) => {
                let title_set = stored.title_set.clone();
                tokio::spawn(async move { Ok(title_set) })
            }
            None => {
                let user_message = UserMessageInput {
                    agent_id: agent_id.clone(),
                    user_id: user_id.clone(),
                    message: message.clone(),
                    attachment_ids: input.attachment_ids.clone(),
                    metadata: metadata.clone(),
                    agent_message: agent_origin.clone(),
                    runtime_written: input.runtime_written,
                    task_notification: input.task_notification.clone(),
                };
                let (thread_id, message_id) = (thread_id.clone(), message_id.clone());
                tokio::spawn(async move {
                    Ok(CONVERSATION_ENGINE_SERVICE
                        .accept_user_message(&user_message, &thread_id, Some(&message_id))
                        .await?
                        .title_set)
                })
            }
        };
        let stored = async move {
            stored
                .await
                .map_err(|error| anyhow::anyhow!("storing the message stopped: {error}"))?
        };

        let Some(claim) = claim else {
            let title_set = match stored.await {
                Ok(title_set) => title_set,
                Err(error) => {
                    // The message is already in the owning turn's inbox — it had to go
                    // there in the same act as the decision. Now the write has failed,
                    // so take it back: left there, the turn would answer text that never
                    // became history, and the next turn would read a reply to nothing.
                    if !THREAD_TURN_SERVICE.withdraw(&thread_id, &pending) {
                        log_error!(
                            "Thread {}: storing a handed-over message failed after the running turn took it; its reply will have no user message in history",
                            thread_id
                        );
                    }
                    return Err(error);
                }
            };
            log_info!(
                "Handed the message to the turn that owns thread {} ({} message(s) pending) instead of starting a new one",
                thread_id,
                THREAD_TURN_SERVICE.pending_count(&thread_id)
            );
            return Ok(no_turn(thread_id, start_time, title_set, true));
        };

        // Build the channel context for delivery — it scopes the response to the
        // originating channel. `channel_id` and `channel_thread_id` may be unset (a
        // direct message), and the adapter then routes to the user's own conversation.
        let channel_context = metadata
            .as_ref()
            .and_then(|metadata| metadata.channel.map(|channel| (channel, metadata)))
            .map(|(channel, metadata)| ChannelContext {
                channel,
                channel_id: metadata.channel_id.clone(),
                channel_thread_id: metadata.channel_thread_id.clone(),
                thread_id: thread_id.clone(),
                include_feedback: None,
            });

        let mut response_texts: Vec<String> = Vec::new();
        let mut all_blocks: Vec<UIBlock> = Vec::new();
        let mut all_tool_calls: Vec<ToolCallRecord> = Vec::new();
        let mut agent_message: Option<ConversationMessage> = None;
        let mut turn_error: Option<InvokeError> = None;
        let mut verbose = false;
        let mut images = TurnImages::default();
        let mut title_set: Option<String> = None;
        let initially_owed = match &input.resumed {
            Some(resumed) => resumed.message_ids.clone(),
            None => vec![message_id.clone()],
        };
        let exchange: SharedExchange = Arc::new(Mutex::new(Exchange {
            owed: initially_owed.clone(),
            turn_ids: initially_owed,
            read: HashMap::new(),
        }));
        // The messages a turn answered in full: its stream ended on its own, so its
        // reply goes out even when a shutdown starts during the delivery.
        let mut answered: Vec<String> = Vec::new();
        let work = ChatWork {
            thread_id: thread_id.clone(),
            agent_id: agent_id.clone(),
            user_id: user_id.clone(),
            metadata: metadata.clone(),
            ..ChatWork::default()
        };
        let mut unsent_attachment_ids = input
            .resumed
            .as_ref()
            .map(|resumed| resumed.unsent_attachment_ids.clone())
            .unwrap_or_default();

        // Hold the thread for the whole exchange — the first turn and any coalesced
        // follow-ups — so a background goal turn can't interleave between them.
        // A `create_goal` call made during this turn kicks its loop fire-and-forget;
        // that loop's first turn queues behind this and runs once we release.
        //
        // The thread is working from here, and a turn that waits for the mutex is part of
        // that work. invoke_stream marks the thread too, which covers turns that do not
        // come through the engine.
        let end_activity = CONVERSATION_THREAD_ACTIVITY_SERVICE.begin_thread(&thread_id, &user_id);
        let controller = CancellationToken::new();
        // A cancelled exchange takes no more hand-overs, so a message sent after the
        // stop gets a turn of its own. A shutdown stops the exchange too. Its messages
        // stay owed, so the next boot continues it.
        let shutdown = PENDING_WORK_SERVICE.shutdown_signal();
        let stopped_already = input
            .abort_signal
            .as_ref()
            .is_some_and(|s| s.is_cancelled())
            || shutdown.is_cancelled();
        if stopped_already {
            controller.cancel();
            claim.close();
        }
        let stopper = (!stopped_already).then(|| {
            let (controller, claim) = (controller.clone(), claim.clone());
            let (abort_signal, shutdown) = (input.abort_signal.clone(), shutdown.clone());
            tokio::spawn(async move {
                let aborted = async {
                    match abort_signal {
                        Some(signal) => signal.cancelled().await,
                        None => std::future::pending().await,
                    }
                };
                tokio::select! {
                    _ = controller.cancelled() => {}
                    _ = aborted => controller.cancel(),
                    _ = shutdown.cancelled() => controller.cancel(),
                }
                claim.close();
            })
        });
        let canceller = self.register_canceller(
            &thread_id,
            Canceller {
                token: controller.clone(),
                claim: claim.clone(),
            },
        );
        let abort_signal = controller.clone();
        let mut store_failed = false;

        let ran = claim
            .run(async {
                let turns = async {
                    title_set = match stored.await {
                        Ok(title_set) => title_set,
                        Err(error) => {
                            store_failed = true;
                            return Err(error);
                        }
                    };

                    if let Some(resumed) = &input.resumed {
                        // The tool calls the interrupted turn made after its last stored
                        // step become history, then leave the rows. A restart between the
                        // two stores them twice, and the model reads each call twice. The
                        // files it shared stay owed on the row the first turn keeps.
                        if !resumed.unsaved.is_empty() {
                            let mut row = MessageInput::new(
                                "",
                                MessageRole::Agent,
                                MessageTrigger::UserInput,
                            );
                            row.tool_calls = Some(serde_json::to_value(&resumed.unsaved)?);
                            row.internal_step = Some(true);
                            CONVERSATION_SERVICE.add_message(&thread_id, row).await?;
                        }
                        // The first row takes every owed file before the others give theirs up.
                        let owed = exchange.lock().owed.clone();
                        if let Some(first) = owed.first() {
                            record_unsaved(&work, first)(Vec::new(), unsent_attachment_ids.clone());
                        }
                        PENDING_WORK_SERVICE.flush().await;
                        for key in owed.iter().skip(1) {
                            PENDING_WORK_SERVICE.update(
                                PendingWorkKind::Chat,
                                key,
                                work_json(&work),
                            );
                        }
                        // The notice is the history's last message, stored like the recalled
                        // memories: every later turn replays it, so the cached prefix holds.
                        let mut notice = MessageInput::new(
                            RESUMED_REPLY_NOTICE,
                            MessageRole::User,
                            MessageTrigger::UserInput,
                        );
                        notice.internal_step = Some(true);
                        CONVERSATION_SERVICE.add_message(&thread_id, notice).await?;
                    }

                    // Snapshot the verbose flag once inside the lock and thread it through
                    // the whole exchange (InvokeRequest → context → delivery gating in
                    // stream_turn), so prompt construction and delivery never diverge if it
                    // is toggled mid-turn — including across any coalesced follow-up.
                    verbose = AGENT_WORKSPACE_SERVICE.get_agent().await?.verbose;

                    let mut prompt = prompt_text(&message, agent_origin.as_ref());
                    let mut append_prompt = false;
                    // Feedback is the person's to give, on a reply to something they asked.
                    let mut prompt_source = prompt_source_of([&pending]);
                    let mut appended_message_ids: Vec<String> = Vec::new();
                    // A resumed exchange stores rows after its message on purpose, and its
                    // history ends on the resume notice.
                    let mut prompt_message_id = input.resumed.is_none().then(|| message_id.clone());
                    // Notices describe events from preparing *this* message (e.g. an
                    // attachment that failed to download), so they belong to the first
                    // turn only — repeating them in a follow-up would re-report stale events.
                    let mut runtime_notices = input.runtime_notices.clone();
                    // The model calls of a turn are spent on the first message it answers.
                    // A message steered into the turn joins that message's request.
                    let mut request_id = exchange.lock().owed.first().cloned().unwrap_or_default();

                    loop {
                        let turn_metadata = match &input.channel_label_for {
                            Some(label_for) => Some(ChatMetadata {
                                channel_label: label_for(thread_id.clone()).await?,
                                ..metadata.clone().unwrap_or_default()
                            }),
                            None => metadata.clone(),
                        };
                        let first_turn_id = exchange.lock().turn_ids.first().cloned();
                        let on_unsaved: OnUnsaved = match &first_turn_id {
                            Some(key) => record_unsaved(&work, key),
                            None => Arc::new(|_: Vec<ToolCallRecord>, _: Vec<String>| {}),
                        };
                        // Drained at every step boundary, so a message handed to us —
                        // even one that arrived while we were still storing or waiting for
                        // the mutex — reaches the model on the next step.
                        let steering: SteeringSource = {
                            let (claim, exchange) = (claim.clone(), Arc::clone(&exchange));
                            Arc::new(move || {
                                let handed = claim.drain(None).unwrap_or_default();
                                let handed = unread(&exchange, take(&exchange, handed));
                                async move {
                                    match CONVERSATION_ENGINE_SERVICE.load_steering(handed).await {
                                        Ok(messages) => messages,
                                        Err(error) => {
                                            log_error!(
                                                json!({ "err": err_json(&error) }),
                                                "Could not read the files of a mid-turn message"
                                            );
                                            Vec::new()
                                        }
                                    }
                                }
                                .boxed()
                            })
                        };
                        // A handed-over message the history holds is answered from there.
                        let on_history_read: HistoryReadListener = {
                            let (claim, exchange) = (claim.clone(), Arc::clone(&exchange));
                            Arc::new(move |rows: &[HistoryRow]| {
                                let read = {
                                    let mut state = exchange.lock();
                                    for row in rows {
                                        let files = row
                                            .attachments
                                            .iter()
                                            .flatten()
                                            .map(|attachment| attachment.id.clone())
                                            .collect();
                                        state.read.insert(row.id.clone(), files);
                                    }
                                    state.read.clone()
                                };
                                let selected = |handed: &PendingMessage| is_read(&read, handed);
                                take(&exchange, claim.drain(Some(&selected)).unwrap_or_default());
                            })
                        };
                        let spend = SpendContext {
                            request_id: request_id.clone(),
                            thread_id: Some(thread_id.clone()),
                            source: Some(SpendSource::of(SpendSourceKind::Chat)),
                        };
                        // Boxed, so the turn's future does not grow the exchange's.
                        let streamed = with_spend_context(
                            spend,
                            self.stream_turn(StreamTurnParams {
                                user_id: user_id.clone(),
                                agent_id: agent_id.clone(),
                                thread_id: thread_id.clone(),
                                workspace_root: workspace_root.clone(),
                                prompt: prompt.clone(),
                                append_prompt,
                                prompt_source,
                                appended_message_ids: appended_message_ids.clone(),
                                verbose,
                                channel_context: channel_context.clone(),
                                metadata: turn_metadata,
                                runtime_notices: runtime_notices.clone(),
                                abort_signal: Some(abort_signal.clone()),
                                on_tool_event: input.on_tool_event.clone(),
                                on_unsaved,
                                unsent_attachment_ids: Some(std::mem::take(
                                    &mut unsent_attachment_ids,
                                )),
                                steering,
                                on_history_read,
                                prompt_message_id: prompt_message_id.clone(),
                            })
                            .boxed(),
                        )
                        .await?;

                        if !streamed.text.is_empty() {
                            response_texts.push(streamed.text);
                        }
                        images.inline += streamed.images.inline;
                        images.missed += streamed.images.missed;
                        images.attached += streamed.images.attached;
                        all_tool_calls.extend(streamed.tool_calls);
                        all_blocks.extend(streamed.blocks);
                        if streamed.agent_message.is_some() {
                            agent_message = streamed.agent_message;
                        }
                        turn_error = streamed.error;
                        {
                            let mut state = exchange.lock();
                            let turn_ids = std::mem::take(&mut state.turn_ids);
                            if streamed.completed {
                                answered.extend(turn_ids);
                            }
                        }

                        // A cancelled turn must not auto-start another one — the user
                        // asked to stop. Anything still pending is cleared when the claim
                        // releases, and stays in history for the next turn.
                        if abort_signal.is_cancelled() {
                            break;
                        }

                        // Messages that landed after the last step boundary never reached
                        // the model. Answer them in ONE coalesced follow-up rather than a
                        // turn each, restating them as the trailing user message (see
                        // `append_prompt`).
                        //
                        // An empty inbox ends the exchange and releases the thread in the
                        // same synchronous act, so no message can be handed to a claim
                        // that is about to end — the next one starts a turn of its own.
                        //
                        // A message the turn read as history it has answered. An inbox that
                        // held only those is asked again, so the claim releases when
                        // nothing else waits.
                        let mut handed = take(&exchange, claim.drain_or_release()?);
                        while !handed.is_empty() && unread(&exchange, handed.clone()).is_empty() {
                            handed = take(&exchange, claim.drain_or_release()?);
                        }
                        let leftover = unread(&exchange, handed);
                        if leftover.is_empty() {
                            break;
                        }

                        // Text only: any files these carried are already linked to their
                        // stored message rows, so the follow-up's context build picks
                        // them up.
                        prompt = leftover
                            .iter()
                            .map(|p| prompt_text(&p.text, p.agent_message.as_ref()))
                            .collect::<Vec<_>>()
                            .join("\n\n");
                        append_prompt = true;
                        prompt_source = prompt_source_of(&leftover);
                        appended_message_ids = leftover.iter().map(|p| p.id.clone()).collect();
                        request_id = leftover[0].id.clone();
                        prompt_message_id = None;
                        runtime_notices = None;
                    }
                    Ok::<(), anyhow::Error>(())
                }
                .await;
                // A cancel or a failure ends the exchange with messages no turn took.
                // They stay in history unanswered, as after any cancel, and are owed
                // nothing.
                take(&exchange, claim.end());
                turns
            })
            .await;

        match &ran {
            Ok(()) => self.events.emit_turn_ended(&ChatTurnEnd {
                thread_id: thread_id.clone(),
                cancelled: abort_signal.is_cancelled(),
                error: turn_error.clone(),
            }),
            // A failure, such as a reply that cannot be stored, leaves the user
            // without an answer.
            Err(_) => self.events.emit_turn_ended(&ChatTurnEnd {
                thread_id: thread_id.clone(),
                cancelled: abort_signal.is_cancelled(),
                error: Some(turn_error.clone().unwrap_or(InvokeError {
                    kind: InvokeErrorType::Generic,
                    detail: None,
                })),
            }),
        }
        // A shutdown keeps the rows of the messages no turn answered in full, and the
        // next boot answers them. Any other end removes the rows, except the row of a
        // message that could not be stored. The next boot stores and answers that
        // message, so a caller who sent it again gets two replies.
        let owed = exchange.lock().owed.clone();
        PENDING_WORK_SERVICE.finish(
            PendingWorkKind::Chat,
            if shutdown.is_cancelled() {
                answered
            } else {
                owed.into_iter()
                    .filter(|id| !(store_failed && *id == message_id))
                    .collect()
            },
        );
        self.unregister_canceller(&thread_id, canceller);
        if let Some(stopper) = stopper {
            stopper.abort();
        }
        end_activity.end();
        ran?;

        let response = response_texts.join("\n\n");

        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), agent_id.clone());
        props.insert("thread.id".to_string(), thread_id.clone());
        props.insert(
            "channel.type".to_string(),
            metadata
                .as_ref()
                .and_then(|metadata| metadata.channel)
                .map_or("api", |channel| channel.as_str())
                .to_string(),
        );
        props.insert(
            "chat.duration_ms".to_string(),
            (now_ms() - start_time).to_string(),
        );
        props.insert(
            "chat.tool_calls".to_string(),
            all_tool_calls.len().to_string(),
        );
        props.insert(
            "chat.response_chars".to_string(),
            js::len16(&response).to_string(),
        );
        props.insert("chat.verbose".to_string(), verbose.to_string());
        props.insert("chat.inline_images".to_string(), images.inline.to_string());
        props.insert(
            "chat.inline_image_misses".to_string(),
            images.missed.to_string(),
        );
        props.insert(
            "chat.attached_files".to_string(),
            images.attached.to_string(),
        );
        track_event("chat message handled", Some(&user_id), Some(props));

        Ok(ChatResponse {
            thread_id,
            // Absent when the turn was cancelled before producing anything, so no
            // message was published.
            message_id: agent_message.map(|message| message.id),
            content: response,
            tool_calls: all_tool_calls,
            blocks: blocks_json(&all_blocks),
            duration_ms: now_ms() - start_time,
            title_set,
            steered: None,
        })
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
        let message_id = id.map_or_else(|| Uuid::new_v4().to_string(), str::to_string);

        // Owed an answer from before it is stored until the exchange that answers it
        // ends, so no restart in between loses it.
        PENDING_WORK_SERVICE
            .begin(
                PendingWorkKind::Chat,
                &message_id,
                work_json(&chat_work_for(input, thread_id)),
            )
            .await?;

        // The message text arrives already prefixed with the sender's mention
        // marker when the channel adapter wants the agent to see it in conversation
        // history.
        let mut row =
            MessageInput::new(&input.message, MessageRole::User, MessageTrigger::UserInput);
        row.id = Some(message_id);
        match &input.agent_message {
            _ if input.task_notification.is_some() => {
                // Hidden: no client shows it. Its row's id is the task's, so the
                // origin needs no column of its own.
                row.triggered_by = TASK_NOTIFICATION_TRIGGER;
                row.internal_step = Some(true);
            }
            Some(origin) => {
                let columns = agent_message_columns(origin);
                row.triggered_by = MessageTrigger::AgentMessage;
                row.trigger_name = columns.trigger_name;
                row.sender_external_id = columns.sender_external_id;
                row.sender_name = columns.sender_name;
                row.external_message_id = columns.external_message_id;
            }
            None => {
                row.sender_external_id = input
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.sender_external_id.clone());
                row.sender_name = input
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.sender_name.clone());
            }
        }
        // A reply the person typed stands in for the answers to any card still waiting.
        // The reply and the card's new status commit together, and clients see the card after that.
        let typed = input.agent_message.is_none()
            && input.task_notification.is_none()
            && !input.runtime_written;
        let (added, closed_cards) = if typed {
            let thread = thread_id.to_string();
            CONVERSATION_SERVICE
                .add_message_with(thread_id, row, move |conn| {
                    QUESTION_CARD_SERVICE.close_waiting_in_chat(conn, &thread)
                })
                .await?
        } else {
            (
                CONVERSATION_SERVICE.add_message(thread_id, row).await?,
                Vec::new(),
            )
        };
        QUESTION_CARD_SERVICE
            .show_closed_in_chat(&input.agent_id, &input.user_id, closed_cards)
            .await;

        // First user message named the thread: announce the placeholder title and
        // kick off the cheap-model upgrade (fire-and-forget, never blocks the
        // turn). Channel-agnostic — transports subscribe to the title service.
        //
        // Skipped for a channel that posts only the agent's replies: its threads are
        // keyed by an externalThreadId, which the web Recents and CLI resume picker
        // never show, so a generated title would cost a model call and a DB write
        // nobody sees.
        let origin = input
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.channel)
            .and_then(|channel| MESSAGE_DELIVERY_SERVICE.get_adapter(channel.as_str()));
        if let Some(title) = &added.title_set
            && origin
                .as_ref()
                .is_none_or(|origin| origin.shows_whole_conversation())
        {
            THREAD_TITLE_SERVICE.on_first_user_message(
                &input.agent_id,
                &input.user_id,
                thread_id,
                &input.message,
                title,
            );
        }

        // Link any uploaded files (pre-send uploads, files a channel downloaded) to
        // the message that carries them so the context builder can expose them.
        if let Some(attachment_ids) = input.attachment_ids.as_ref().filter(|ids| !ids.is_empty()) {
            ATTACHMENT_SERVICE
                .link_to_message(attachment_ids, &added.message.id, thread_id)
                .await?;
        }

        // A channel that shows the whole conversation gets the person's own words
        // on every device — the sender's included, which reads the copy as the
        // confirmation that it was stored. Any other channel shows the message
        // itself.
        if input.task_notification.is_none()
            && origin
                .as_ref()
                .is_some_and(|origin| origin.shows_whole_conversation())
        {
            MESSAGE_DELIVERY_SERVICE
                .show_in_conversation(&input.user_id, &added.message)
                .await?;
        }

        Ok(added)
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
        try_join_all(pending.into_iter().map(|p| async move {
            let attachments = if p.attachment_ids.is_empty() {
                None
            } else {
                Some(
                    ATTACHMENT_SERVICE
                        .get_meta_by_ids(&p.attachment_ids)
                        .await?,
                )
            };
            Ok::<SteeringMessage, anyhow::Error>(SteeringMessage {
                text: p.text,
                attachments,
                agent_message: p.agent_message,
            })
        }))
        .await
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
        let StreamTurnParams {
            user_id,
            agent_id,
            thread_id,
            prompt,
            channel_context,
            metadata,
            ..
        } = &params;

        let mut agent_message: Option<ConversationMessage> = None;
        let mut pending_tool_calls: Vec<ToolCallRecord> = Vec::new();
        let mut buffered_step: Option<InvokeStep> = None;
        let mut buffered_tool_calls: Vec<ToolCallRecord> = Vec::new();
        let mut response_texts: Vec<String> = Vec::new();
        let mut all_blocks: Vec<UIBlock> = Vec::new();
        let mut all_tool_calls: Vec<ToolCallRecord> = Vec::new();
        // Files the agent shared (share_file) accrue across steps. A delivered step
        // takes the images its text places; the rest ride out on the final delivered
        // message, so they appear alongside the answer.
        let mut all_attachment_ids: Vec<String> =
            params.unsent_attachment_ids.clone().unwrap_or_default();
        let mut images = TurnImages::default();
        // In verbose mode a step's images are read when the step arrives, not when
        // the next text step flushes it, so a later step that rewrites or deletes
        // the file does not change what this step's text describes.
        let mut buffered_placed: Option<PlacedImages> = None;
        let mut error: Option<InvokeError> = None;
        // Whether the row holds calls or files that this turn's reply takes over.
        let mut owes = !all_attachment_ids.is_empty();

        let request = InvokeRequest {
            user_id: user_id.clone(),
            agent_id: agent_id.clone(),
            mode: InvokeMode::Chat,
            prompt: prompt.clone(),
            prompt_source: Some(params.prompt_source),
            append_prompt: params.append_prompt,
            appended_message_ids: Some(params.appended_message_ids.clone()),
            prompt_message_id: params.prompt_message_id.clone(),
            thread_id: Some(thread_id.clone()),
            workspace_root: params.workspace_root.clone(),
            verbose: Some(params.verbose),
            channel_label: metadata.as_ref().and_then(|m| m.channel_label.clone()),
            origin_channel: metadata.as_ref().and_then(|m| m.channel),
            origin_channel_id: metadata.as_ref().and_then(|m| m.channel_id.clone()),
            runtime_notices: params.runtime_notices.clone(),
            abort_signal: params.abort_signal.clone(),
            on_tool_event: params.on_tool_event.clone(),
            steering: Some(Arc::clone(&params.steering)),
            on_history_read: Some(Arc::clone(&params.on_history_read)),
            ..InvokeRequest::default()
        };
        let mut steps = stream_of(request);
        while let Some(step) = steps.next().await {
            let step = step?;
            all_tool_calls.extend(step.tool_calls.iter().cloned());
            if let Some(blocks) = &step.blocks {
                all_blocks.extend(blocks.iter().cloned());
            }
            if let Some(attachment_ids) = &step.attachment_ids {
                all_attachment_ids.extend(attachment_ids.iter().cloned());
            }
            pending_tool_calls.extend(step.tool_calls.iter().cloned());
            error = step.error.clone();

            if !step.text.is_empty() {
                response_texts.push(step.text.clone());

                // Flush the previously buffered step now that we know it wasn't last:
                // no blocks, no feedback gate.
                if let Some(buffered) = &buffered_step {
                    if params.verbose {
                        let placed = match buffered_placed.take() {
                            Some(placed) => placed,
                            None => {
                                place(
                                    thread_id,
                                    params.workspace_root.as_deref(),
                                    &all_attachment_ids,
                                    &buffered.text,
                                )
                                .await
                            }
                        };
                        let placed = deliver(placed, &mut all_attachment_ids, &mut images);
                        agent_message = Some(
                            MESSAGE_DELIVERY_SERVICE
                                .publish(
                                    user_id,
                                    thread_id,
                                    &placed.content,
                                    MessageTrigger::UserInput,
                                    PublishOptions {
                                        tool_calls: non_empty(&buffered_tool_calls),
                                        attachment_ids: non_empty(&placed.attachment_ids),
                                        channel_context: channel_context.clone().map(|context| {
                                            ChannelContext {
                                                include_feedback: Some(false),
                                                ..context
                                            }
                                        }),
                                        ..PublishOptions::default()
                                    },
                                )
                                .await?,
                        );
                    } else {
                        // Concise mode: persist without delivering to the channel. Marked
                        // internal_step so client history hides it, while the model-context
                        // read still replays it (tool rounds must survive for the model).
                        let mut row = MessageInput::new(
                            buffered.text.clone(),
                            MessageRole::Agent,
                            MessageTrigger::UserInput,
                        );
                        row.tool_calls = non_empty(&buffered_tool_calls)
                            .map(serde_json::to_value)
                            .transpose()?;
                        row.internal_step = Some(true);
                        agent_message = Some(
                            CONVERSATION_SERVICE
                                .add_message(thread_id, row)
                                .await?
                                .message,
                        );
                    }
                }

                buffered_step = Some(step.clone());
                buffered_placed = if params.verbose {
                    Some(
                        place(
                            thread_id,
                            params.workspace_root.as_deref(),
                            &all_attachment_ids,
                            &step.text,
                        )
                        .await,
                    )
                } else {
                    None
                };
                buffered_tool_calls = std::mem::take(&mut pending_tool_calls);
            }
            if !step.tool_calls.is_empty() || !step.text.is_empty() {
                let unsaved: Vec<ToolCallRecord> = buffered_tool_calls
                    .iter()
                    .chain(pending_tool_calls.iter())
                    .cloned()
                    .collect();
                owes = !unsaved.is_empty() || !all_attachment_ids.is_empty();
                (params.on_unsaved)(unsaved, all_attachment_ids.clone());
            }
        }

        // Read before the delivery: an abort that lands during it stops no answer.
        let completed = !params
            .abort_signal
            .as_ref()
            .is_some_and(|signal| signal.is_cancelled());
        let response = response_texts.join("\n\n");

        // A turn a shutdown stopped delivers nothing. Its row keeps what the turn did,
        // and the next boot continues the turn from there.
        if !completed && PENDING_WORK_SERVICE.shutdown_signal().is_cancelled() {
            return Ok(StreamedTurn {
                text: response,
                tool_calls: all_tool_calls,
                blocks: all_blocks,
                agent_message,
                error,
                completed,
                images,
            });
        }

        // The stream is done. The buffered step (if any) is the LAST text step:
        // attach the accumulated blocks and the feedback decision here.
        if let Some(buffered) = &buffered_step {
            let include_feedback = params.prompt_source == PromptSource::Person
                && self
                    .should_show_feedback(
                        thread_id,
                        prompt,
                        Some(&buffered.text),
                        user_id,
                        agent_id,
                        params.abort_signal.as_ref(),
                    )
                    .await?;
            let placed = match buffered_placed.take() {
                Some(placed) => placed,
                None => {
                    place(
                        thread_id,
                        params.workspace_root.as_deref(),
                        &all_attachment_ids,
                        &buffered.text,
                    )
                    .await
                }
            };
            let placed = deliver(placed, &mut all_attachment_ids, &mut images);
            let attachment_ids: Vec<String> = placed
                .attachment_ids
                .iter()
                .chain(all_attachment_ids.iter())
                .cloned()
                .collect();
            images.attached += all_attachment_ids.len();
            agent_message = Some(
                MESSAGE_DELIVERY_SERVICE
                    .publish(
                        user_id,
                        thread_id,
                        &placed.content,
                        MessageTrigger::UserInput,
                        PublishOptions {
                            tool_calls: non_empty(&buffered_tool_calls),
                            blocks: blocks_json(&all_blocks),
                            attachment_ids: non_empty(&attachment_ids),
                            channel_context: channel_context.clone().map(|context| {
                                ChannelContext {
                                    include_feedback: Some(include_feedback),
                                    ..context
                                }
                            }),
                            ..PublishOptions::default()
                        },
                    )
                    .await?,
            );
        }

        // A question card is the turn's whole reply: the row keeps its tool call for the
        // model and shows nothing under the card.
        let asked = all_tool_calls
            .iter()
            .any(|call| call.tool == ASK_QUESTIONS_TOOL_NAME && call.success);
        if agent_message.is_none()
            && asked
            && all_blocks.is_empty()
            && all_attachment_ids.is_empty()
        {
            let mut row = MessageInput::new(
                response.clone(),
                MessageRole::Agent,
                MessageTrigger::UserInput,
            );
            row.tool_calls = Some(serde_json::to_value(&all_tool_calls)?);
            row.internal_step = Some(true);
            agent_message = Some(
                CONVERSATION_SERVICE
                    .add_message(thread_id, row)
                    .await?
                    .message,
            );
        }

        // Fallback: the stream produced no text step. Publish only if there's still
        // something to show (tool calls, UI blocks or files) — e.g. a tool-only turn.
        // When a turn is cancelled before producing anything, skip it rather than
        // render an empty agent bubble. (In this branch `response` is always empty,
        // because any text step would have set `agent_message` via the buffered-step
        // publish.)
        if agent_message.is_none()
            && (!all_tool_calls.is_empty()
                || !all_blocks.is_empty()
                || !all_attachment_ids.is_empty())
        {
            images.attached += all_attachment_ids.len();
            agent_message = Some(
                MESSAGE_DELIVERY_SERVICE
                    .publish(
                        user_id,
                        thread_id,
                        &response,
                        MessageTrigger::UserInput,
                        PublishOptions {
                            tool_calls: non_empty(&all_tool_calls),
                            blocks: blocks_json(&all_blocks),
                            attachment_ids: non_empty(&all_attachment_ids),
                            channel_context: channel_context.clone(),
                            ..PublishOptions::default()
                        },
                    )
                    .await?,
            );
        }
        // The reply holds the turn's calls and files now.
        if owes {
            (params.on_unsaved)(Vec::new(), Vec::new());
        }

        Ok(StreamedTurn {
            text: response,
            tool_calls: all_tool_calls,
            blocks: all_blocks,
            agent_message,
            error,
            completed,
            images,
        })
    }
}

/// The images `text` places, read from the run's workspace, with the files this
/// turn shared that no message holds yet.
async fn place(
    thread_id: &str,
    workspace_root: Option<&str>,
    shared: &[String],
    text: &str,
) -> PlacedImages {
    place_inline_images(
        text,
        &PlacementContext {
            thread_id,
            workspace_root,
            shared,
        },
    )
    .await
}

/// A delivered step takes the images it placed out of the files still owed.
fn deliver(placed: PlacedImages, owed: &mut Vec<String>, images: &mut TurnImages) -> PlacedImages {
    owed.retain(|id| !placed.attachment_ids.contains(id));
    images.inline += placed.attachment_ids.len();
    images.missed += placed.missed;
    placed
}

impl Default for ConversationEngineService {
    fn default() -> Self {
        Self::new()
    }
}

pub static CONVERSATION_ENGINE_SERVICE: LazyLock<ConversationEngineService> =
    LazyLock::new(ConversationEngineService::new);

/// The steps of one invocation: `invoke_stream`, or what a test put in its place.
fn stream_of(
    request: InvokeRequest,
) -> futures::stream::BoxStream<'static, anyhow::Result<InvokeStep>> {
    #[cfg(test)]
    if let Some(invoke) = testing::INVOKE.read().clone() {
        return invoke(request);
    }
    invoke_stream(request)
}

#[cfg(test)]
mod prompt_source_tests {
    use super::*;

    fn pending(agent: bool, task: bool) -> PendingMessage {
        PendingMessage {
            id: "m".into(),
            text: "t".into(),
            attachment_ids: Vec::new(),
            agent_message: agent.then(|| AgentMessageOrigin {
                kind: crate::protocol::chat_protocol::AgentMessageKind::Message,
                sender_id: "a".into(),
                sender_name: "A".into(),
                message_id: "x".into(),
            }),
            task_notification: task.then(|| TaskNotificationOrigin {
                task_id: "task-1".into(),
            }),
        }
    }

    #[test]
    fn names_the_person_when_any_message_is_theirs_else_agents_else_the_runtime() {
        assert_eq!(
            prompt_source_of(&[pending(false, false)]),
            PromptSource::Person
        );
        assert_eq!(
            prompt_source_of(&[pending(false, true), pending(false, false)]),
            PromptSource::Person
        );
        assert_eq!(
            prompt_source_of(&[pending(false, true), pending(true, false)]),
            PromptSource::Agent
        );
        assert_eq!(
            prompt_source_of(&[pending(false, true)]),
            PromptSource::Task
        );
    }
}

/// What tests set in place of the model.
#[cfg(test)]
pub(crate) mod testing {
    use std::sync::Arc;

    use futures::stream::BoxStream;
    use parking_lot::RwLock;

    use crate::types::{InvokeRequest, InvokeStep};

    /// Runs one invocation in place of `invoke_stream`.
    pub(crate) type Invoke =
        Arc<dyn Fn(InvokeRequest) -> BoxStream<'static, anyhow::Result<InvokeStep>> + Send + Sync>;

    pub(crate) static INVOKE: RwLock<Option<Invoke>> = RwLock::new(None);
}

#[cfg(test)]
mod spend_tests {
    use std::sync::Arc;

    use futures::StreamExt;

    use super::*;
    use crate::lib::spend_context::current_spend_context;
    use crate::services::question_cards::question_card_service::tests::{
        THREAD, USER, agent, agent_id, rows,
    };
    use crate::types::{InvokeRequest, InvokeStep};

    #[tokio::test]
    #[serial_test::serial]
    async fn spends_the_model_calls_of_a_turn_on_the_message_it_answers() {
        let _db = agent().await;
        let seen: Arc<parking_lot::Mutex<Vec<Option<SpendContext>>>> = Arc::default();
        let record = seen.clone();
        *testing::INVOKE.write() = Some(Arc::new(move |_: InvokeRequest| {
            record.lock().push(current_spend_context());
            futures::stream::iter(vec![Ok(InvokeStep {
                text: "ok".into(),
                ..InvokeStep::default()
            })])
            .boxed()
        }));

        Box::pin(CONVERSATION_ENGINE_SERVICE.chat(ChatInput {
            agent_id: agent_id(),
            user_id: USER.into(),
            message: "hi".into(),
            thread_id: Some(THREAD.into()),
            ..ChatInput::default()
        }))
        .await
        .unwrap();

        let stored = rows(THREAD)
            .await
            .into_iter()
            .find(|row| row.role == crate::db::models::MessageRole::User)
            .unwrap();
        assert_eq!(
            *seen.lock(),
            vec![Some(SpendContext {
                request_id: stored.id,
                thread_id: Some(THREAD.into()),
                source: Some(SpendSource::of(SpendSourceKind::Chat)),
            })]
        );
    }
}
