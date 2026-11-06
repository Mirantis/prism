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

use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::db::models::ConversationMessage;
use crate::protocol::chat_protocol::{NackCode, TurnOutcome, TurnState};
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::conversation_engine_service::{
    CONVERSATION_ENGINE_SERVICE, ChatInput, ChatMetadata, ChatTurnEnd,
};
use crate::services::conversation_thread_activity_service::CONVERSATION_THREAD_ACTIVITY_SERVICE;
use crate::types::{AgentMessageOrigin, ResumedReply};

/// Who sent a message, as the Lens Agents sign-in named the connection.
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
    /// Who sent it, as the Lens Agents sign-in named the connection: a stable id,
    /// which tells one person's messages from another's, and a name to show. The
    /// sign-in gives an email, or a user id, which serves as both today.
    pub sender: Option<InboundSender>,
    /// Set when another agent of the project sent it, and `sender` is then `None`.
    pub agent_message: Option<AgentMessageOrigin>,
}

#[derive(Debug, Clone)]
pub struct Acceptance {
    pub message: ConversationMessage,
    /// A stream position at or after the stored message's `message` event.
    pub seq: i64,
    pub queued: bool,
    pub duplicate: bool,
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

/// How a turn ended, as every client is told it.
#[derive(Debug, Clone)]
struct TurnEnding {
    outcome: TurnOutcome,
    error: Option<String>,
}

/// How a turn ended, as every client is told it.
fn outcome_of(ended: &ChatTurnEnd) -> TurnEnding {
    todo!()
}

/// How a message's sender is stored: a person's id as the external id and the
/// name for display, or the other agent's origin, which only this service sets.
struct SenderInput {
    metadata: ChatMetadata,
    agent_message: Option<AgentMessageOrigin>,
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
    }
}

/// One event per message received, a person's or another agent's, whether or not it came before.
fn track_received(message: &InboundMessage, duplicate: bool) {
    todo!()
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

/// An acceptance in flight, shared by every copy of one send.
type AcceptanceInFlight = Shared<BoxFuture<'static, Result<Acceptance, Arc<anyhow::Error>>>>;

pub struct InboundMessageService {
    /// Acceptances in flight, by message id, so two copies of one send share one row.
    accepting: Mutex<HashMap<String, AcceptanceInFlight>>,
    waiting: Mutex<VecDeque<Waiting>>,
    /// The thread of the turn this service is running, if one is.
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
    pub async fn accept(&self, message: InboundMessage) -> anyhow::Result<Acceptance> {
        todo!()
    }

    /// Stop the conversation's work: its running turn, whoever started it, and its
    /// messages still waiting. Those stay in history, unanswered, as after any cancel.
    /// Answers whether there was anything to stop. A client stops only this agent's
    /// web conversations (`InboundMessageError` otherwise).
    pub async fn cancel(&self, thread_id: &str) -> anyhow::Result<bool> {
        todo!()
    }

    /// Continue a reply a restart interrupted, in its turn: it waits like any
    /// message, behind the ones accepted before it.
    pub fn resume(&self, message: &ConversationMessage, resumed: ResumedReply) {
        todo!()
    }

    /// Every conversation with work queued or running, for a client that just connected.
    pub fn turns(&self) -> Vec<TurnSummary> {
        self.announced
            .lock()
            .iter()
            .map(|(thread_id, state)| TurnSummary {
                thread_id: thread_id.clone(),
                state: state.clone(),
            })
            .collect()
    }

    async fn accept_once(&self, inbound: InboundMessage) -> anyhow::Result<Acceptance> {
        todo!()
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
        &self,
        existing: ConversationMessage,
        received: InboundMessage,
    ) -> anyhow::Result<Acceptance> {
        todo!()
    }

    /// A turn reads the thread that holds the message. Single-thread mode hides every other
    /// web thread and answers in the one conversation, which does not hold it.
    async fn turn_reads_thread(&self, message: &ConversationMessage) -> anyhow::Result<bool> {
        todo!()
    }

    /// Only this agent's web conversations that clients may see take messages from the socket.
    async fn check_thread(&self, thread_id: &str, agent_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    async fn has_answer(&self, message: &ConversationMessage) -> anyhow::Result<bool> {
        todo!()
    }

    fn has_work(&self, thread_id: &str) -> bool {
        self.announced.lock().contains_key(thread_id)
            || self.running_thread_id.lock().as_deref() == Some(thread_id)
    }

    /// Schedule a message that is already stored, and never fail: from here the
    /// client is told the message is safe, and a failure that reached it would say
    /// the opposite. Offering it to a running turn needs the database; when that
    /// fails, the message waits its turn instead of being offered.
    async fn schedule_stored(&self, waiting: Waiting) -> bool {
        todo!()
    }

    /// Hand the message to the turn running on its thread, run it, or queue it.
    /// Answers whether it was queued.
    async fn schedule(&self, waiting: Waiting) -> anyhow::Result<bool> {
        todo!()
    }

    /// Answer one message, then the next one waiting. Never fails.
    async fn run(&self, waiting: Waiting) {
        todo!()
    }

    /// The chat input that answers a waiting message.
    async fn chat_input(&self, waiting: &Waiting) -> anyhow::Result<ChatInput> {
        todo!()
    }

    /// Tell every client the thread's state, when it differs from what they were last told.
    fn announce(&self, thread_id: &str) {
        todo!()
    }

    fn state_of(&self, thread_id: &str) -> TurnState {
        todo!()
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

pub static INBOUND_MESSAGE_SERVICE: LazyLock<InboundMessageService> =
    LazyLock::new(InboundMessageService::new);
