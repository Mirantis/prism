//! Thread Turn Service
//!
//! The one per-thread primitive: turns on a thread run one at a time, FIFO, and
//! the turn that owns a thread has a mid-turn inbox.
//!
//! Two rules, one object, because they are the same rule seen twice:
//!
//! 1. **Exclusive.** Every model invocation on a thread — interactive chat turns
//!    and background goal turns alike — runs under the thread's mutex, so two of
//!    them never build context from the same thread concurrently.
//!
//! 2. **Steerable.** A chat turn *claims* the thread. A claim takes hand-overs
//!    from the instant it claims until it closes or releases: in that time a
//!    message arriving on that thread is handed to it (`claim_or_offer`, `offer`)
//!    instead of starting a turn of its own. A turn releases once it has answered
//!    everything, and a cancelled one closes at the stop (`close`). The claiming
//!    turn picks the message up at its next step boundary — text and any files
//!    alike — so the user can redirect work in flight instead of waiting minutes
//!    for a turn that then answers a question the agent has moved past.
//!
//! Without this, a message arriving mid-turn started a *second* turn that queued
//! behind the lock. By the time it ran, the first turn had appended its own
//! replies, so the assembled history no longer ended on that user's turn — which
//! Bedrock/Anthropic reject outright ("This model does not support assistant
//! message prefill. The conversation must end with a user message."), and each
//! failed turn's error reply then terminated the next queued turn's history in
//! turn, cascading.
//!
//! **Why a claim and not "is it invoking right now".** The claim is what makes
//! the offer-vs-own decision atomic. It is taken synchronously, in the same tick
//! as the decision it follows, and *before* the owner does any of its own work:
//! before it stores the message, before it waits for the mutex, before it builds
//! context. Any signal derived from the invocation itself would start only after
//! those awaits, and a message landing in between would find the thread free,
//! start a turn of its own, and hit the prefill failure above.
//!
//! A caller that takes the mutex without claiming (the goal loop, via `run()`) is
//! simply not steerable: an autonomous turn is not redirected by a user message.
//!
//! Channel-agnostic: transports (channel adapters, WS gateway) never touch this —
//! they call the conversation engine, which owns the offer/own/coalesce decision.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::types::AgentMessageOrigin;

/// A message waiting to reach the turn that owns a thread.
///
/// Files travel as ids, not bytes: this is pushed from a synchronous `offer()`,
/// and whoever takes the message loads the bytes on its own side.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMessage {
    /// The stored message's id, so the turn that answers it can say so.
    pub id: String,
    pub text: String,
    /// Ids of already-uploaded attachments the message carried.
    pub attachment_ids: Vec<String>,
    /// Set when another agent sent it, so the turn reads it as that agent's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_message: Option<AgentMessageOrigin>,
}

/// One claim's messages, oldest first. Compared by identity (`Arc::ptr_eq`).
type Inbox = Arc<Mutex<Vec<PendingMessage>>>;

struct ThreadState {
    /// The FIFO queue of mutex acquisitions. Tokio's mutex serves waiters in
    /// arrival order, and a failed turn does not poison the next waiter.
    mutex: Arc<tokio::sync::Mutex<()>>,
    /// Mutex acquisitions queued or running; keeps the entry alive.
    refs: usize,
    /// The inbox of the claim that takes hand-overs now, or `None` when the thread is free.
    accepting: Option<Inbox>,
    /// The inbox of every claim not yet released, the accepting one and any closed one.
    open: Vec<Inbox>,
    /// Callers of `claim_when_free`, each given the claim in turn when the one
    /// before stops taking hand-overs.
    queued: VecDeque<oneshot::Sender<ThreadClaim>>,
}

impl ThreadState {
    fn new() -> Self {
        ThreadState {
            mutex: Arc::new(tokio::sync::Mutex::new(())),
            refs: 0,
            accepting: None,
            open: Vec::new(),
            queued: VecDeque::new(),
        }
    }
}

struct ClaimInner {
    thread_id: String,
    inbox: Inbox,
    open: AtomicBool,
}

/// The thread, taken by the turn that answers a message. It takes hand-overs from
/// the moment it is taken until it closes or releases, which is why nothing can
/// slip between "no turn has this thread" and "this turn has it".
///
/// Every method other than `end` and `close` fails with
/// `ThreadClaim.<method>() used after the claim on thread <id> ended` once the
/// claim has ended.
#[derive(Clone)]
pub struct ThreadClaim {
    inner: Arc<ClaimInner>,
}

impl ThreadClaim {
    /// Run `fut` under the thread's mutex, then release the claim. Turns on a
    /// thread run one at a time, FIFO, so `fut` may start well after the claim was
    /// taken — the inbox has been collecting messages in the meantime.
    pub async fn run<T>(&self, fut: impl Future<Output = anyhow::Result<T>>) -> anyhow::Result<T> {
        todo!()
    }

    /// Take what is pending, oldest first, or only the messages `which` selects.
    pub fn drain(
        &self,
        which: Option<&dyn Fn(&PendingMessage) -> bool>,
    ) -> anyhow::Result<Vec<PendingMessage>> {
        todo!()
    }

    /// Take what is pending, or release the claim when nothing is. Synchronous, so
    /// the emptiness test and the release are one act: a message cannot arrive
    /// between them and be accepted by a claim that is about to end.
    ///
    /// This is how a turn ends its exchange — an empty result means the thread is
    /// free again, and the next message starts a turn of its own.
    pub fn drain_or_release(&self) -> anyhow::Result<Vec<PendingMessage>> {
        todo!()
    }

    /// Release the claim now and hand back what no turn took, for an exchange that
    /// ends by a cancel or a throw. The messages stay in history, unanswered.
    /// Returns nothing once the claim has ended.
    pub fn end(&self) -> Vec<PendingMessage> {
        todo!()
    }

    /// Stop taking hand-overs, for an exchange that was cancelled and is still
    /// unwinding. The next message takes the thread and gets a turn of its own,
    /// which runs once this one leaves the mutex. What was handed over before
    /// stays with this claim until it ends.
    pub fn close(&self) {
        todo!()
    }
}

/// Log a warning past this many pending messages — a sign of a stuck turn.
const PENDING_WARN_THRESHOLD: usize = 20;

pub struct ThreadTurnService {
    threads: Mutex<HashMap<String, ThreadState>>,
}

impl ThreadTurnService {
    pub fn new() -> Self {
        ThreadTurnService {
            threads: Mutex::new(HashMap::new()),
        }
    }

    /// Take the thread for a turn about to answer `message`, or hand `message` to
    /// the turn that already has it.
    ///
    /// Returns the claim when this caller owns the turn, or `None` when the message
    /// was handed over — the caller then stores it (it is real history) and does
    /// not invoke the model. Synchronous by design: the decision and the hand-over
    /// are one act, so two messages arriving at the same time cannot both conclude
    /// the thread is free.
    ///
    /// Takes the `PendingMessage` rather than its parts so a caller whose own work
    /// fails afterwards can name it again and `withdraw()` it.
    pub fn claim_or_offer(&self, thread_id: &str, message: PendingMessage) -> Option<ThreadClaim> {
        todo!()
    }

    /// Take the thread once no claim takes hand-overs on it. A claim that closes or
    /// releases passes straight to the first caller waiting here, so no message can
    /// take the thread between them. For an exchange that must not be handed to
    /// another turn.
    pub async fn claim_when_free(&self, thread_id: &str) -> ThreadClaim {
        todo!()
    }

    /// Hand `message` to the turn that owns `thread_id`, without ever taking the
    /// thread.
    ///
    /// Returns false when no turn owns it, which tells the caller the message is
    /// theirs to deal with — for transports that keep their own queue (the WS
    /// gateway) and fall back to it.
    pub fn offer(&self, thread_id: &str, message: PendingMessage) -> bool {
        todo!()
    }

    /// Take back a message handed to the owning turn, if that turn has not drained
    /// it yet. Returns false when it is already gone — the model has seen it, and no
    /// bookkeeping here can undo that. The message is matched by its `id`.
    ///
    /// For the caller whose own follow-up work failed: a hand-over happens *before*
    /// the message is stored (the decision has to be one synchronous act), so a
    /// failed write would otherwise leave the running turn answering text that never
    /// became history.
    pub fn withdraw(&self, thread_id: &str, message: &PendingMessage) -> bool {
        todo!()
    }

    /// Run `fut` under the thread's mutex without claiming the thread: exclusive,
    /// but not steerable. For turns a user message must not redirect (the goal
    /// loop) — a chat turn goes through `claim_or_offer()` instead.
    pub async fn run<T>(&self, thread_id: &str, fut: impl Future<Output = T>) -> T {
        todo!()
    }

    /// True while a turn takes hand-overs on the thread (logs/tests).
    pub fn is_claimed(&self, thread_id: &str) -> bool {
        self.threads
            .lock()
            .get(thread_id)
            .is_some_and(|state| state.accepting.is_some())
    }

    /// How many messages are waiting on the turns that hold claims on the thread
    /// (logs/tests).
    pub fn pending_count(&self, thread_id: &str) -> usize {
        self.threads.lock().get(thread_id).map_or(0, |state| {
            state.open.iter().map(|inbox| inbox.lock().len()).sum()
        })
    }

    /// Whether the thread still holds any state. Only an idle thread should be
    /// untracked, so this is how tests pin that nothing outlives its turn.
    pub fn is_tracked(&self, thread_id: &str) -> bool {
        self.threads.lock().contains_key(thread_id)
    }

    /// Whether any thread is mid-exchange — a turn running or queued on the
    /// mutex, a claim still open between turns, or a follow-up waiting in an
    /// inbox. `forget()` drops a thread's entry as soon as all three are clear,
    /// so a tracked thread is exactly a busy one.
    pub fn has_live_exchange(&self) -> bool {
        !self.threads.lock().is_empty()
    }

    async fn with_mutex<T>(&self, thread_id: &str, fut: impl Future<Output = T>) -> T {
        todo!()
    }

    /// A new claim on the thread, which takes hand-overs from now on. A claim that
    /// stops taking hand-overs passes the thread to the first caller waiting for it,
    /// in the same act, so no message can take it between them.
    fn claim_for(&self, thread_id: &str, state: &mut ThreadState) -> ThreadClaim {
        todo!()
    }

    /// Release a claim: stop its hand-overs, drop its inbox and hand back what no
    /// turn took. Nothing pending outlives the turn that could have answered it;
    /// the messages are stored either way, so they stay in history for the next
    /// turn to read.
    fn release(&self, claim: &ClaimInner) -> Vec<PendingMessage> {
        todo!()
    }

    fn push(&self, thread_id: &str, inbox: &Inbox, message: PendingMessage) {
        todo!()
    }

    /// Drop a thread's entry once nothing references it, so the map doesn't grow
    /// one permanent entry per thread for the process lifetime. An open claim keeps
    /// the entry, which is what lets a claim outlive the mutex acquisition it wraps.
    fn forget(threads: &mut HashMap<String, ThreadState>, thread_id: &str) {
        if let Some(state) = threads.get(thread_id) {
            if state.refs == 0 && state.open.is_empty() {
                threads.remove(thread_id);
            }
        }
    }
}

impl Default for ThreadTurnService {
    fn default() -> Self {
        Self::new()
    }
}

pub static THREAD_TURN_SERVICE: LazyLock<ThreadTurnService> = LazyLock::new(ThreadTurnService::new);
