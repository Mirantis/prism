//! Inbound Message Service
//!
//! Owns what happens to a message a person sends over the chat socket: it is
//! stored under the id the client chose, confirmed, and then answered — in the
//! order messages arrived, one turn at a time for the agent. It also owns what
//! every client is told about each conversation's work: queued, running or idle.
//!
//! **Stored before anything else.** A message is written the moment it is
//! accepted, and only then scheduled. The queue therefore holds rows that already
//! exist, so nothing can lose a message that has been confirmed — not a client
//! going away, and not a queue that drains with nobody connected. A resend of the
//! same id finds its row and is confirmed again without a second answer.
//!
//! **One turn at a time.** A message for a conversation whose turn is running is
//! handed to that turn, which reads it at its next step. A message for another
//! conversation waits until the running turn ends, and every client sees it as
//! queued. The waiting is what "Prism is stopped" means while a person holds the
//! computer: the turn that asked for help is still running.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock};

use diesel::prelude::*;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::oneshot;

use crate::config::CONFIG;
use crate::db::models::{ConversationMessage, MessageRole, MessageTrigger};
use crate::db::schema::conversation_messages::dsl as m;
use crate::db::schema::conversation_threads::dsl as t;
use crate::db::sql_types::DbDateTime;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::prompts::agent_message_prompt::{AgentMessageColumns, agent_message_origin};
use crate::prompts::context_builder::with_sender_tag;
use crate::prompts::task_notification_prompt::task_notification_origin;
use crate::protocol::chat_protocol::{
    NackCode, StreamEvent, TURN_FAILED, TurnEventPayload, TurnOutcome, TurnState, turn_error,
};
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::conversation_engine_service::{
    CONVERSATION_ENGINE_SERVICE, ChatInput, ChatMetadata, ChatTurnEnd, ChatWork, StoredMessage,
    UserMessageInput, chat_work_for,
};
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::services::conversation_thread_activity_service::{
    CONVERSATION_THREAD_ACTIVITY_SERVICE, ThreadMark,
};
use crate::services::event_stream_service::EVENT_STREAM_SERVICE;
use crate::services::message_delivery_service::MESSAGE_DELIVERY_SERVICE;
use crate::services::pending_work_service::{PENDING_WORK_SERVICE, PendingWorkKind};
use crate::services::web_chat_label::web_chat_label;
use crate::services::web_thread::web_thread;
use crate::support::after_accept::{AcceptGate, spawn_after_accept, within_gate};
use crate::types::{AgentMessageOrigin, ResumedReply, TaskNotificationOrigin};
use crate::{log_error, log_info};

/// Who sent a message, as the Mirantis Agent Platform sign-in named the connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboundSender {
    /// A stable id, which tells one person's messages from another's.
    pub id: String,
    /// A name to show.
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct InboundMessage {
    /// The client's id for the message, which becomes the row's.
    pub id: String,
    pub thread_id: String,
    pub content: String,
    pub attachment_ids: Vec<String>,
    /// Who sent it, as the Mirantis Agent Platform sign-in named the connection: a stable id,
    /// which tells one person's messages from another's, and a name to show. The
    /// sign-in gives an email, or a user id, which serves as both today.
    pub sender: Option<InboundSender>,
    /// Set when another agent of the project sent it, and `sender` is then `None`.
    pub agent_message: Option<AgentMessageOrigin>,
    /// The runtime wrote it in the person's name, so it leaves a waiting question card open.
    pub runtime_written: bool,
    /// Set on the runtime's report that a coding task ended, which only a stored row carries.
    pub task_notification: Option<TaskNotificationOrigin>,
}

#[derive(Debug, Clone)]
pub struct Acceptance {
    pub message: ConversationMessage,
    /// A stream position at or after the stored message's `message` event.
    pub seq: i64,
    pub queued: bool,
    pub duplicate: bool,
    /// Holds back the work the message started (its turn, its title) until the
    /// caller drops it, so a confirmation the caller sends first goes out before
    /// anything that work sends.
    gate: Option<AcceptGate>,
}

impl Acceptance {
    /// Let the work the message started run now, for a caller that has nothing to
    /// confirm first.
    pub fn release_turn(&mut self) {
        self.gate = None;
    }
}

/// A refusal the client can act on, with the code it is sent under.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct InboundMessageError {
    pub code: NackCode,
    pub message: String,
}

impl InboundMessageError {
    pub fn new(code: NackCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

const STARTING: &str = "The agent is still starting. Try again shortly.";

/// How a turn ended, as every client is told it.
#[derive(Debug, Clone)]
struct TurnEnding {
    outcome: TurnOutcome,
    error: Option<String>,
}

/// How a turn ended, as every client is told it.
fn outcome_of(ended: &ChatTurnEnd) -> TurnEnding {
    if ended.cancelled {
        return TurnEnding {
            outcome: TurnOutcome::Cancelled,
            error: None,
        };
    }
    match &ended.error {
        None => TurnEnding {
            outcome: TurnOutcome::Completed,
            error: None,
        },
        Some(error) => TurnEnding {
            outcome: TurnOutcome::Failed,
            error: Some(turn_error(error).to_string()),
        },
    }
}

/// How a message's sender is stored: a person's id as the external id and the
/// name for display, or the other agent's origin, which only this service sets.
struct SenderInput {
    metadata: ChatMetadata,
    agent_message: Option<AgentMessageOrigin>,
    task_notification: Option<TaskNotificationOrigin>,
}

fn sender_input(message: &InboundMessage) -> SenderInput {
    let metadata = ChatMetadata {
        channel: Some(ChannelName::Websocket),
        ..ChatMetadata::default()
    };
    if let Some(agent_message) = &message.agent_message {
        return SenderInput {
            metadata,
            agent_message: Some(agent_message.clone()),
            task_notification: None,
        };
    }
    if let Some(task_notification) = &message.task_notification {
        return SenderInput {
            metadata,
            agent_message: None,
            task_notification: Some(task_notification.clone()),
        };
    }
    let metadata = match &message.sender {
        Some(sender) => ChatMetadata {
            sender_external_id: Some(sender.id.clone()),
            sender_name: Some(sender.name.clone()),
            ..metadata
        },
        None => metadata,
    };
    SenderInput {
        metadata,
        agent_message: None,
        task_notification: None,
    }
}

/// What the engine stores for a message.
fn engine_input(message: &InboundMessage, agent_id: String) -> UserMessageInput {
    let sender = sender_input(message);
    UserMessageInput {
        agent_id,
        user_id: CONFIG.owner_user_id(),
        message: message.content.clone(),
        attachment_ids: Some(message.attachment_ids.clone()),
        metadata: Some(sender.metadata),
        agent_message: sender.agent_message,
        runtime_written: message.runtime_written,
        task_notification: sender.task_notification,
        generated_ui_press: false,
    }
}

/// One event per message received, a person's or another agent's, whether or not it came before.
fn track_received(message: &InboundMessage, duplicate: bool) {
    let mut props = IndexMap::new();
    if let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) {
        props.insert("agent.id".to_string(), agent_id);
    }
    props.insert("thread.id".to_string(), message.thread_id.clone());
    let owner = CONFIG.owner_user_id();
    if let Some(origin) = &message.agent_message {
        props.insert(
            "agent_message.kind".to_string(),
            origin.kind.as_str().to_string(),
        );
        props.insert("agent_message.duplicate".to_string(), duplicate.to_string());
        props.insert(
            "agent_message.attachments".to_string(),
            message.attachment_ids.len().to_string(),
        );
        track_event("agent message received", Some(&owner), Some(props));
        return;
    }
    props.insert("chat.duplicate".to_string(), duplicate.to_string());
    props.insert(
        "chat.attachments".to_string(),
        message.attachment_ids.len().to_string(),
    );
    track_event("chat message received", Some(&owner), Some(props));
}

/// The origin columns of a stored message.
/// A stored row as the queue holds it. The row keeps who sent it; the turn reads the sender from there.
fn stored_inbound(message: &ConversationMessage) -> InboundMessage {
    InboundMessage {
        id: message.id.clone(),
        thread_id: message.thread_id.clone(),
        content: message.content.clone(),
        attachment_ids: Vec::new(),
        sender: None,
        agent_message: origin_of(message),
        runtime_written: false,
        task_notification: task_notification_origin(&message.id, Some(message.triggered_by)),
    }
}

fn origin_of(message: &ConversationMessage) -> Option<AgentMessageOrigin> {
    agent_message_origin(&AgentMessageColumns {
        triggered_by: Some(message.triggered_by.as_str().to_string()),
        trigger_name: message.trigger_name.clone(),
        sender_external_id: message.sender_external_id.clone(),
        sender_name: message.sender_name.clone(),
        external_message_id: message.external_message_id.clone(),
    })
}

/// Whether an error is the database refusing a second row with the same id.
fn is_unique_violation(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<diesel::result::Error>(),
            Some(diesel::result::Error::DatabaseError(
                diesel::result::DatabaseErrorKind::UniqueViolation,
                _
            ))
        )
    })
}

/// A stored message waiting for its turn.
#[derive(Debug, Clone)]
struct Waiting {
    message: InboundMessage,
    title_set: Option<String>,
    /// Set when the turn continues one a restart interrupted.
    resumed: Option<ResumedReply>,
}

/// A conversation with work queued or running.
#[derive(Debug, Clone)]
pub struct TurnSummary {
    pub thread_id: String,
    /// `Queued` or `Running`; an idle conversation is not listed.
    pub state: TurnState,
}

/// An acceptance in flight, which every other copy of one send waits for: the
/// stored acceptance, or `None` when the first copy failed.
type AcceptanceInFlight = Shared<BoxFuture<'static, Option<Acceptance>>>;

/// Takes an acceptance off the in-flight list once its first copy is done, also
/// when that copy stops part-way.
struct InFlightEntry {
    id: String,
}

impl Drop for InFlightEntry {
    fn drop(&mut self) {
        INBOUND_MESSAGE_SERVICE.accepting.lock().remove(&self.id);
    }
}

pub struct InboundMessageService {
    /// Acceptances in flight, by message id, so two copies of one send share one row.
    accepting: Mutex<HashMap<String, AcceptanceInFlight>>,
    waiting: Mutex<VecDeque<Waiting>>,
    /// The thread of the turn this service is running, if one is. Locked before
    /// `waiting` wherever both are read together.
    running_thread_id: Mutex<Option<String>>,
    /// How a thread's last turn ended, told once with the `idle` that follows it.
    outcomes: Mutex<HashMap<String, TurnEnding>>,
    /// The state each thread was last announced in. Idle threads are not kept.
    announced: Mutex<IndexMap<String, TurnState>>,
}

impl InboundMessageService {
    /// Subscribes here, at construction, rather than by the gateway: the turn state
    /// is this service's to announce. The boot touches the service so the
    /// subscriptions are in place before the first turn.
    pub fn new() -> Self {
        CONVERSATION_THREAD_ACTIVITY_SERVICE
            .events
            .on_change(|change| INBOUND_MESSAGE_SERVICE.announce(&change.thread_id));
        // Every exchange the engine runs, whoever started it, so the `idle` after it says how it ended.
        CONVERSATION_ENGINE_SERVICE.events.on_turn_ended(|ended| {
            INBOUND_MESSAGE_SERVICE
                .outcomes
                .lock()
                .insert(ended.thread_id.clone(), outcome_of(ended));
        });
        Self {
            accepting: Mutex::new(HashMap::new()),
            waiting: Mutex::new(VecDeque::new()),
            running_thread_id: Mutex::new(None),
            outcomes: Mutex::new(HashMap::new()),
            announced: Mutex::new(IndexMap::new()),
        }
    }

    /// Store a message and schedule its answer. Resolves once the message is stored,
    /// which is when the client may stop offering to send it again. A second copy
    /// while the first is being stored waits for it, then gets the answer any
    /// resend gets: the same check against the stored row. Refusals fail with
    /// `InboundMessageError`.
    pub async fn accept(&'static self, message: InboundMessage) -> anyhow::Result<Acceptance> {
        let (accepted, gate) = within_gate(self.accept_ungated(message)).await;
        let mut accepted = accepted?;
        accepted.gate = Some(gate);
        Ok(accepted)
    }

    async fn accept_ungated(&'static self, message: InboundMessage) -> anyhow::Result<Acceptance> {
        loop {
            let in_flight = self.accepting.lock().get(&message.id).cloned();
            if let Some(in_flight) = in_flight {
                match in_flight.await {
                    Some(first) => return self.accept_duplicate(first.message, message).await,
                    // The first copy failed: this one tries again on its own.
                    None => continue,
                }
            }

            let (done, outcome) = oneshot::channel::<Acceptance>();
            {
                let mut accepting = self.accepting.lock();
                if accepting.contains_key(&message.id) {
                    continue;
                }
                accepting.insert(message.id.clone(), outcome.map(Result::ok).boxed().shared());
            }
            let _entry = InFlightEntry {
                id: message.id.clone(),
            };
            let accepted = self.accept_once(message).await;
            if let Ok(acceptance) = &accepted {
                let _ = done.send(acceptance.clone());
            }
            return accepted;
        }
    }

    /// Stop the conversation's work: its running turn, whoever started it, and its
    /// messages still waiting. Those stay in history, unanswered, as after any cancel.
    /// Answers whether there was anything to stop. A client stops only this agent's
    /// web conversations (`InboundMessageError` otherwise).
    pub async fn cancel(&self, thread_id: &str) -> anyhow::Result<bool> {
        let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) else {
            return Err(InboundMessageError::new(NackCode::Unavailable, STARTING).into());
        };
        // The same bar as a send: a client stops only this agent's web conversations.
        self.check_thread(thread_id, &agent_id).await?;
        let dropped: Vec<Waiting> = {
            let mut waiting = self.waiting.lock();
            let mut dropped = Vec::new();
            for index in (0..waiting.len()).rev() {
                if waiting[index].message.thread_id == thread_id {
                    dropped.extend(waiting.remove(index));
                }
            }
            dropped
        };
        // Stopped, so no longer owed an answer.
        let keys: Vec<String> = dropped
            .iter()
            .flat_map(|w| match &w.resumed {
                Some(resumed) => resumed.message_ids.clone(),
                None => vec![w.message.id.clone()],
            })
            .collect();
        PENDING_WORK_SERVICE.end(PendingWorkKind::Chat, keys);
        let stopped = CONVERSATION_ENGINE_SERVICE.cancel(thread_id);
        if !dropped.is_empty() {
            self.announce(thread_id);
        }
        Ok(stopped || !dropped.is_empty())
    }

    /// Continue a reply a restart interrupted, in its turn: it waits like any
    /// message, behind the ones accepted before it.
    pub fn resume(&'static self, message: &ConversationMessage, resumed: ResumedReply) {
        let waiting = Waiting {
            message: stored_inbound(message),
            title_set: None,
            resumed: Some(resumed),
        };
        tokio::spawn(async move {
            self.schedule_stored(waiting).await;
        });
    }

    /// Answer a message the runtime stored itself, such as a task notification: a
    /// turn running on its thread reads it at its next step, and otherwise it waits
    /// like any message, behind the ones accepted before it.
    pub fn answer_stored(&'static self, message: &ConversationMessage) {
        let waiting = Waiting {
            message: stored_inbound(message),
            title_set: None,
            resumed: None,
        };
        tokio::spawn(async move {
            self.schedule_stored(waiting).await;
        });
    }

    /// Every conversation with work queued or running, for a client that just connected.
    pub fn turns(&self) -> Vec<TurnSummary> {
        self.announced
            .lock()
            .iter()
            .map(|(thread_id, state)| TurnSummary {
                thread_id: thread_id.clone(),
                state: *state,
            })
            .collect()
    }

    async fn accept_once(&'static self, inbound: InboundMessage) -> anyhow::Result<Acceptance> {
        let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) else {
            return Err(InboundMessageError::new(NackCode::Unavailable, STARTING).into());
        };
        self.check_thread(&inbound.thread_id, &agent_id).await?;

        if let Some(existing) = find_message(&inbound.id).await? {
            return self.accept_duplicate(existing, inbound).await;
        }

        let stored = CONVERSATION_ENGINE_SERVICE
            .accept_user_message(
                &engine_input(&inbound, agent_id),
                &inbound.thread_id,
                Some(&inbound.id),
            )
            .await;
        let stored = match stored {
            Ok(stored) => stored,
            Err(error) => {
                // Another process wrote the id between the lookup and the insert. There
                // is one process per agent, so this is a restart racing a resend.
                if is_unique_violation(&error)
                    && let Some(raced) = find_message(&inbound.id).await?
                {
                    return self.accept_duplicate(raced, inbound).await;
                }
                return Err(error);
            }
        };

        track_received(&inbound, false);

        let queued = self
            .schedule_stored(Waiting {
                message: inbound,
                title_set: stored.title_set,
                resumed: None,
            })
            .await;
        Ok(Acceptance {
            message: stored.message,
            seq: EVENT_STREAM_SERVICE.seq(),
            queued,
            duplicate: false,
            gate: None,
        })
    }

    /// The id is already a row. A person's message in the same conversation is the
    /// same message sent again, and is confirmed again. So is another agent's
    /// message delivered again, from the same sender with the same message id, in
    /// the conversation that holds it: the newest conversation can be another one
    /// by then. Anything else is refused: the id is the client's choice, and must
    /// not attach to an agent's reply, to another sender's message or to another
    /// conversation. The client then offers to send it again.
    ///
    /// A confirmed message whose turn never ran — the process stopped between the
    /// store and the turn — is scheduled now, as the row holds it: the history
    /// shows the row, so the turn answers its words and its sender. One with an
    /// answer after it, or with work under way on its thread, is left alone:
    /// answering it twice is worse.
    async fn accept_duplicate(
        &'static self,
        existing: ConversationMessage,
        received: InboundMessage,
    ) -> anyhow::Result<Acceptance> {
        let from_agent = received.agent_message.is_some();
        let same_kind = existing.role == MessageRole::User
            && (existing.triggered_by == MessageTrigger::AgentMessage) == from_agent;
        let stored = origin_of(&existing);
        let same_sender = match &received.agent_message {
            None => true,
            Some(origin) => stored.as_ref().is_some_and(|stored| {
                stored.sender_id == origin.sender_id && stored.message_id == origin.message_id
            }),
        };
        if !same_kind || !same_sender || (!from_agent && existing.thread_id != received.thread_id) {
            return Err(InboundMessageError::new(
                NackCode::IdConflict,
                "That message id is already taken by another message.",
            )
            .into());
        }
        let inbound = InboundMessage {
            thread_id: existing.thread_id.clone(),
            content: existing.content.clone(),
            agent_message: stored.or(received.agent_message.clone()),
            ..received
        };

        track_received(&inbound, true);

        let mut queued = self.announced.lock().get(&inbound.thread_id) == Some(&TurnState::Queued);
        if !self.has_work(&inbound.thread_id)
            && !self.has_answer(&existing).await?
            && self.turn_reads_thread(&existing).await?
        {
            log_info!(
                "Message {} was stored but never answered; scheduling it now",
                existing.id
            );
            queued = self
                .schedule_stored(Waiting {
                    message: inbound,
                    title_set: None,
                    resumed: None,
                })
                .await;
        }
        // Shown again: if the first attempt failed after storing the row, no client
        // has seen it yet. Clients replace a message they already have.
        MESSAGE_DELIVERY_SERVICE
            .show_in_conversation(&CONFIG.owner_user_id(), &existing)
            .await?;
        Ok(Acceptance {
            message: existing,
            seq: EVENT_STREAM_SERVICE.seq(),
            queued,
            duplicate: true,
            gate: None,
        })
    }

    /// A turn reads the thread that holds the message. Single-thread mode hides every other
    /// web thread and answers in the one conversation, which does not hold it.
    async fn turn_reads_thread(&self, message: &ConversationMessage) -> anyhow::Result<bool> {
        if CONVERSATION_SERVICE
            .writable_thread_id(&message.thread_id)
            .await?
            == message.thread_id
        {
            return Ok(true);
        }
        log_info!(
            "Not answering message {}: single-thread mode hides thread {}",
            message.id,
            message.thread_id
        );
        Ok(false)
    }

    /// What `pending_work` holds for `message` until its answer ends, as `accept` writes it.
    pub fn pending_work_for(&self, message: &InboundMessage) -> ChatWork {
        chat_work_for(
            &engine_input(message, CONFIG.agent_id().unwrap_or_default()),
            &message.thread_id,
        )
    }

    /// Only this agent's web conversations that clients may see take messages from the socket.
    pub async fn check_thread(&self, thread_id: &str, agent_id: &str) -> anyhow::Result<()> {
        let filter = CONVERSATION_SERVICE
            .client_thread_filter(agent_id, &CONFIG.owner_user_id())
            .await?;
        let id = thread_id.to_string();
        let thread = crate::db::run(move |conn| {
            Ok(t::conversation_threads
                .filter(t::id.eq(id))
                .filter(web_thread())
                .select(crate::db::models::ConversationThread::as_select())
                .first(conn)
                .optional()?)
        })
        .await?;
        let known =
            thread.is_some_and(|thread| filter.allows(&thread) && thread.agent_id == agent_id);
        if !known {
            return Err(InboundMessageError::new(
                NackCode::UnknownThread,
                "That conversation does not exist.",
            )
            .into());
        }
        Ok(())
    }

    async fn has_answer(&self, message: &ConversationMessage) -> anyhow::Result<bool> {
        let (thread_id, created_at) = (message.thread_id.clone(), message.created_at);
        let reply = crate::db::run(move |conn| {
            Ok(m::conversation_messages
                .filter(m::thread_id.eq(thread_id))
                .filter(m::role.eq(MessageRole::Agent))
                .filter(m::internal_step.eq(false))
                .filter(m::created_at.gt(DbDateTime(created_at)))
                .select(m::id)
                .first::<String>(conn)
                .optional()?)
        })
        .await?;
        Ok(reply.is_some())
    }

    fn has_work(&self, thread_id: &str) -> bool {
        self.announced.lock().contains_key(thread_id)
            || self.running_thread_id.lock().as_deref() == Some(thread_id)
    }

    /// Schedule a message that is already stored, and never fail: from here the
    /// client is told the message is safe, and a failure that reached it would say
    /// the opposite. Offering it to a running turn needs the database; when that
    /// fails, the message waits its turn instead of being offered.
    async fn schedule_stored(&'static self, waiting: Waiting) -> bool {
        match self.schedule(waiting.clone()).await {
            Ok(queued) => queued,
            Err(error) => {
                log_error!(
                    "Could not offer message {} to the running turn; queueing it: {}",
                    waiting.message.id,
                    error
                );
                self.run_or_queue(waiting)
            }
        }
    }

    /// Hand the message to the turn running on its thread, run it, or queue it.
    /// Answers whether it was queued.
    async fn schedule(&'static self, waiting: Waiting) -> anyhow::Result<bool> {
        if self.running_thread_id.lock().is_some() {
            // A turn is under way. One on this message's own thread reads it at its
            // next step, which is how a correction mid-answer steers the work.
            let mut input = self.chat_input(&waiting).await?;
            input.steer_only = Some(true);
            let offered = CONVERSATION_ENGINE_SERVICE.chat(input).await?;
            if offered.steered == Some(true) {
                return Ok(false);
            }
            // The running turn can end while the offer awaits its thread lookup. It
            // has already looked for the next message by then, so nothing would run
            // this one: it runs now.
        }
        Ok(self.run_or_queue(waiting))
    }

    /// Run the message now when no turn is running, else queue it behind the
    /// running one. Answers whether it was queued.
    fn run_or_queue(&'static self, waiting: Waiting) -> bool {
        let thread_id = waiting.message.thread_id.clone();
        let to_run = {
            let mut running = self.running_thread_id.lock();
            if running.is_some() {
                self.waiting.lock().push_back(waiting);
                None
            } else {
                *running = Some(thread_id.clone());
                Some(waiting)
            }
        };
        match to_run {
            Some(waiting) => {
                self.start(waiting);
                false
            }
            None => {
                self.announce(&thread_id);
                true
            }
        }
    }

    /// Start the turn of a message this service has just made the running one.
    fn start(&'static self, waiting: Waiting) {
        let thread_id = waiting.message.thread_id.clone();
        self.announce(&thread_id);
        // Held until the outcome is recorded, so the `idle` every client sees carries
        // how the turn ended rather than arriving before it is known.
        let end_hold =
            CONVERSATION_THREAD_ACTIVITY_SERVICE.begin_thread(&thread_id, &CONFIG.owner_user_id());
        spawn_after_accept(async move { self.run(waiting, end_hold).await });
    }

    /// Answer one message, then the next one waiting. Never fails.
    async fn run(&'static self, waiting: Waiting, end_hold: ThreadMark) {
        let thread_id = waiting.message.thread_id.clone();
        let result = async {
            let input = self.chat_input(&waiting).await?;
            CONVERSATION_ENGINE_SERVICE.chat(input).await
        }
        .await;
        if let Err(error) = result {
            // Through the serializer, which redacts; every client gets a sentence
            // instead, since an error can carry request content or internals.
            log_error!(
                json!({ "err": err_json(&error), "threadId": thread_id }),
                "Turn failed"
            );
            self.outcomes.lock().insert(
                thread_id.clone(),
                TurnEnding {
                    outcome: TurnOutcome::Failed,
                    error: Some(TURN_FAILED.to_string()),
                },
            );
        }
        *self.running_thread_id.lock() = None;
        end_hold.end();
        // A turn that ended without the activity changing still owes its `idle`.
        self.announce(&thread_id);

        let next = {
            let mut running = self.running_thread_id.lock();
            if running.is_some() {
                None
            } else {
                let next = self.waiting.lock().pop_front();
                if let Some(next) = &next {
                    *running = Some(next.message.thread_id.clone());
                }
                next
            }
        };
        if let Some(next) = next {
            self.start(next);
        }
    }

    /// The chat input that answers a waiting message.
    async fn chat_input(&self, waiting: &Waiting) -> anyhow::Result<ChatInput> {
        let message = &waiting.message;
        let channel_label = web_chat_label(&message.thread_id).await?;
        let sender = sender_input(message);
        // Tagged the way a turn with the channel instructions renders the stored row,
        // so a message handed to a running turn reads the same there as later.
        let text = if channel_label.is_some() {
            with_sender_tag(
                &message.content,
                message.sender.as_ref().map(|s| s.id.as_str()),
                message.sender.as_ref().map(|s| s.name.as_str()),
            )
        } else {
            message.content.clone()
        };
        Ok(ChatInput {
            agent_id: CONFIG.agent_id().unwrap_or_default(),
            user_id: CONFIG.owner_user_id(),
            message: text,
            thread_id: Some(message.thread_id.clone()),
            attachment_ids: Some(message.attachment_ids.clone()),
            stored: Some(StoredMessage {
                id: message.id.clone(),
                title_set: waiting.title_set.clone(),
            }),
            resumed: waiting.resumed.clone(),
            metadata: Some(sender.metadata),
            agent_message: sender.agent_message,
            task_notification: sender.task_notification,
            channel_label_for: Some(Arc::new(|thread_id: String| {
                async move { web_chat_label(&thread_id).await }.boxed()
            })),
            ..ChatInput::default()
        })
    }

    /// Tell every client the thread's state, when it differs from what they were last told.
    fn announce(&self, thread_id: &str) {
        // Under the stream's lock, so two announcements of one thread reach the
        // stream in the order their states were read.
        EVENT_STREAM_SERVICE.exclusive(|| {
            let state = self.state_of(thread_id);
            let payload = {
                let mut announced = self.announced.lock();
                let before = announced.get(thread_id).copied().unwrap_or(TurnState::Idle);
                if state == before {
                    return;
                }
                if state == TurnState::Idle {
                    announced.shift_remove(thread_id);
                } else {
                    announced.insert(thread_id.to_string(), state);
                }

                let mut payload = TurnEventPayload {
                    thread_id: thread_id.to_string(),
                    state,
                    outcome: None,
                    error: None,
                };
                let mut outcomes = self.outcomes.lock();
                if state == TurnState::Idle && before == TurnState::Running {
                    let ended = outcomes.get(thread_id).cloned().unwrap_or(TurnEnding {
                        outcome: TurnOutcome::Completed,
                        error: None,
                    });
                    payload.outcome = Some(ended.outcome);
                    payload.error = ended.error.filter(|error| !error.is_empty());
                }
                if state == TurnState::Idle {
                    outcomes.remove(thread_id);
                }
                payload
            };
            EVENT_STREAM_SERVICE.publish(StreamEvent::Turn(payload));
        });
    }

    fn state_of(&self, thread_id: &str) -> TurnState {
        if CONVERSATION_THREAD_ACTIVITY_SERVICE
            .working_thread_ids()
            .iter()
            .any(|id| id == thread_id)
        {
            return TurnState::Running;
        }
        if self.running_thread_id.lock().as_deref() == Some(thread_id) {
            return TurnState::Running;
        }
        if self
            .waiting
            .lock()
            .iter()
            .any(|w| w.message.thread_id == thread_id)
        {
            return TurnState::Queued;
        }
        TurnState::Idle
    }

    /// Forget everything, as a restart would. For tests.
    pub fn reset_for_tests(&self) {
        self.accepting.lock().clear();
        self.waiting.lock().clear();
        *self.running_thread_id.lock() = None;
        self.outcomes.lock().clear();
        self.announced.lock().clear();
    }
}

impl Default for InboundMessageService {
    fn default() -> Self {
        Self::new()
    }
}

/// The stored message with this id, if there is one.
pub(crate) async fn find_message(id: &str) -> anyhow::Result<Option<ConversationMessage>> {
    let id = id.to_string();
    crate::db::run(move |conn| {
        Ok(m::conversation_messages
            .filter(m::id.eq(id))
            .select(ConversationMessage::as_select())
            .first(conn)
            .optional()?)
    })
    .await
}

pub static INBOUND_MESSAGE_SERVICE: LazyLock<InboundMessageService> =
    LazyLock::new(InboundMessageService::new);
