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
use crate::{log_info, log_warn};

/// A message waiting to reach the turn that owns a thread.
///
/// Files travel as ids, not bytes: this is pushed from a synchronous `offer()`,
/// and whoever takes the message loads the bytes on its own side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

/// Every tracked thread. Locked before any inbox, so a hand-over and a release
/// are each one act.
type Threads = Arc<Mutex<HashMap<String, ThreadState>>>;

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
    threads: Threads,
    thread_id: String,
    inbox: Inbox,
    open: AtomicBool,
}

impl ClaimInner {
    fn check(&self, method: &str) -> anyhow::Result<()> {
        if !self.open.load(Ordering::SeqCst) {
            anyhow::bail!(
                "ThreadClaim.{method}() used after the claim on thread {} ended",
                self.thread_id
            );
        }
        Ok(())
    }

    /// Stop taking hand-overs, and pass the thread to the first caller waiting for
    /// it, in the same act, so no message can take it between them.
    fn close_locked(&self, threads: &mut HashMap<String, ThreadState>) {
        let Some(state) = threads.get_mut(&self.thread_id) else {
            return;
        };
        if !state
            .accepting
            .as_ref()
            .is_some_and(|accepting| Arc::ptr_eq(accepting, &self.inbox))
        {
            return;
        }
        state.accepting = None;
        while let Some(next) = state.queued.pop_front() {
            let claim = claim_for(&self.threads, &self.thread_id, state);
            match next.send(claim) {
                Ok(()) => break,
                // The caller stopped waiting: its claim goes back at once.
                Err(unwanted) => {
                    unwanted.inner.open.store(false, Ordering::SeqCst);
                    state.accepting = None;
                    state
                        .open
                        .retain(|inbox| !Arc::ptr_eq(inbox, &unwanted.inner.inbox));
                }
            }
        }
    }

    /// Release the claim with the threads locked, and hand back what no turn took.
    fn release_locked(&self, threads: &mut HashMap<String, ThreadState>) -> Vec<PendingMessage> {
        if !self.open.swap(false, Ordering::SeqCst) {
            return Vec::new();
        }
        self.close_locked(threads);
        if let Some(state) = threads.get_mut(&self.thread_id) {
            state.open.retain(|inbox| !Arc::ptr_eq(inbox, &self.inbox));
        }
        let abandoned = std::mem::take(&mut *self.inbox.lock());
        ThreadTurnService::forget(threads, &self.thread_id);
        abandoned
    }

    /// Release a claim: stop its hand-overs, drop its inbox and hand back what no
    /// turn took. Nothing pending outlives the turn that could have answered it. A
    /// turn ends its exchange through `drain_or_release()`, which only releases on
    /// an empty inbox, so anything here belongs to a turn that ended some other
    /// way: a cancel, or a throw. The messages are stored either way, so they stay
    /// in history for the next turn to read; keeping the pending copy would
    /// instead hand that turn text it has already seen.
    fn release(&self) -> Vec<PendingMessage> {
        let abandoned = {
            let mut threads = self.threads.lock();
            self.release_locked(&mut threads)
        };
        if !abandoned.is_empty() {
            log_info!(
                "Thread {} released with {} message(s) no turn took; they stay in history",
                self.thread_id,
                abandoned.len()
            );
        }
        abandoned
    }
}

/// Releases a claim when the turn it runs ends, however it ends.
struct ReleaseOnDrop<'a>(&'a ClaimInner);

impl Drop for ReleaseOnDrop<'_> {
    fn drop(&mut self) {
        self.0.release();
    }
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
        self.inner.check("run")?;
        let _release = ReleaseOnDrop(&self.inner);
        with_mutex(&self.inner.threads, &self.inner.thread_id, fut).await
    }

    /// Take what is pending, oldest first, or only the messages `which` selects.
    pub fn drain(
        &self,
        which: Option<&dyn Fn(&PendingMessage) -> bool>,
    ) -> anyhow::Result<Vec<PendingMessage>> {
        self.inner.check("drain")?;
        let mut inbox = self.inner.inbox.lock();
        let Some(which) = which else {
            return Ok(std::mem::take(&mut *inbox));
        };
        let (taken, kept): (Vec<PendingMessage>, Vec<PendingMessage>) = std::mem::take(&mut *inbox)
            .into_iter()
            .partition(|m| which(m));
        *inbox = kept;
        Ok(taken)
    }

    /// Take what is pending, or release the claim when nothing is. Synchronous, so
    /// the emptiness test and the release are one act: a message cannot arrive
    /// between them and be accepted by a claim that is about to end.
    ///
    /// This is how a turn ends its exchange — an empty result means the thread is
    /// free again, and the next message starts a turn of its own.
    pub fn drain_or_release(&self) -> anyhow::Result<Vec<PendingMessage>> {
        self.inner.check("drainOrRelease")?;
        let mut threads = self.inner.threads.lock();
        let pending = std::mem::take(&mut *self.inner.inbox.lock());
        if pending.is_empty() {
            self.inner.release_locked(&mut threads);
        }
        Ok(pending)
    }

    /// Release the claim now and hand back what no turn took, for an exchange that
    /// ends by a cancel or a throw. The messages stay in history, unanswered.
    /// Returns nothing once the claim has ended.
    pub fn end(&self) -> Vec<PendingMessage> {
        self.inner.release()
    }

    /// Stop taking hand-overs, for an exchange that was cancelled and is still
    /// unwinding. The next message takes the thread and gets a turn of its own,
    /// which runs once this one leaves the mutex. What was handed over before
    /// stays with this claim until it ends.
    pub fn close(&self) {
        if !self.inner.open.load(Ordering::SeqCst) {
            return;
        }
        let mut threads = self.inner.threads.lock();
        self.inner.close_locked(&mut threads);
    }
}

/// Log a warning past this many pending messages — a sign of a stuck turn.
const PENDING_WARN_THRESHOLD: usize = 20;

/// A new claim on the thread, which takes hand-overs from now on.
fn claim_for(threads: &Threads, thread_id: &str, state: &mut ThreadState) -> ThreadClaim {
    let inbox: Inbox = Arc::new(Mutex::new(Vec::new()));
    state.accepting = Some(Arc::clone(&inbox));
    state.open.push(Arc::clone(&inbox));
    ThreadClaim {
        inner: Arc::new(ClaimInner {
            threads: Arc::clone(threads),
            thread_id: thread_id.to_string(),
            inbox,
            open: AtomicBool::new(true),
        }),
    }
}

fn state_for<'a>(
    threads: &'a mut HashMap<String, ThreadState>,
    thread_id: &str,
) -> &'a mut ThreadState {
    threads
        .entry(thread_id.to_string())
        .or_insert_with(ThreadState::new)
}

/// Gives back a mutex acquisition's hold on the thread's entry, however the turn
/// ends.
struct MutexRef<'a> {
    threads: &'a Threads,
    thread_id: &'a str,
}

impl Drop for MutexRef<'_> {
    fn drop(&mut self) {
        let mut threads = self.threads.lock();
        if let Some(state) = threads.get_mut(self.thread_id) {
            state.refs -= 1;
        }
        ThreadTurnService::forget(&mut threads, self.thread_id);
    }
}

async fn with_mutex<T>(threads: &Threads, thread_id: &str, fut: impl Future<Output = T>) -> T {
    let mutex = {
        let mut map = threads.lock();
        let state = state_for(&mut map, thread_id);
        state.refs += 1;
        Arc::clone(&state.mutex)
    };
    let _held = MutexRef { threads, thread_id };
    let _turn = mutex.lock().await;
    fut.await
}

pub struct ThreadTurnService {
    threads: Threads,
}

impl ThreadTurnService {
    pub fn new() -> Self {
        ThreadTurnService {
            threads: Arc::new(Mutex::new(HashMap::new())),
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
        let mut threads = self.threads.lock();
        let state = state_for(&mut threads, thread_id);
        if let Some(accepting) = state.accepting.clone() {
            Self::push(thread_id, &accepting, message);
            return None;
        }
        Some(claim_for(&self.threads, thread_id, state))
    }

    /// Take the thread once no claim takes hand-overs on it. A claim that closes or
    /// releases passes straight to the first caller waiting here, so no message can
    /// take the thread between them. For an exchange that must not be handed to
    /// another turn.
    pub async fn claim_when_free(&self, thread_id: &str) -> ThreadClaim {
        loop {
            let waiting = {
                let mut threads = self.threads.lock();
                let state = state_for(&mut threads, thread_id);
                if state.accepting.is_none() {
                    return claim_for(&self.threads, thread_id, state);
                }
                let (sender, receiver) = oneshot::channel();
                state.queued.push_back(sender);
                receiver
            };
            if let Ok(claim) = waiting.await {
                return claim;
            }
        }
    }

    /// Hand `message` to the turn that owns `thread_id`, without ever taking the
    /// thread.
    ///
    /// Returns false when no turn owns it, which tells the caller the message is
    /// theirs to deal with — for transports that keep their own queue (the WS
    /// gateway) and fall back to it.
    pub fn offer(&self, thread_id: &str, message: PendingMessage) -> bool {
        let threads = self.threads.lock();
        let Some(inbox) = threads
            .get(thread_id)
            .and_then(|state| state.accepting.clone())
        else {
            return false;
        };
        Self::push(thread_id, &inbox, message);
        true
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
        let threads = self.threads.lock();
        let Some(state) = threads.get(thread_id) else {
            return false;
        };
        for inbox in &state.open {
            let mut inbox = inbox.lock();
            if let Some(index) = inbox.iter().position(|pending| pending.id == message.id) {
                inbox.remove(index);
                return true;
            }
        }
        false
    }

    /// Run `fut` under the thread's mutex without claiming the thread: exclusive,
    /// but not steerable. For turns a user message must not redirect (the goal
    /// loop) — a chat turn goes through `claim_or_offer()` instead.
    pub async fn run<T>(&self, thread_id: &str, fut: impl Future<Output = T>) -> T {
        with_mutex(&self.threads, thread_id, fut).await
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

    fn push(thread_id: &str, inbox: &Inbox, message: PendingMessage) {
        let waiting = {
            let mut inbox = inbox.lock();
            inbox.push(message);
            inbox.len()
        };
        if waiting == PENDING_WARN_THRESHOLD {
            log_warn!(
                "Thread {} has {} messages waiting on the turn that owns it — the turn may be stuck",
                thread_id,
                waiting
            );
        }
    }

    /// Drop a thread's entry once nothing references it, so the map doesn't grow
    /// one permanent entry per thread for the process lifetime. An open claim keeps
    /// the entry, which is what lets a claim outlive the mutex acquisition it wraps.
    fn forget(threads: &mut HashMap<String, ThreadState>, thread_id: &str) {
        if let Some(state) = threads.get(thread_id)
            && state.refs == 0
            && state.open.is_empty()
        {
            threads.remove(thread_id);
        }
    }
}

impl Default for ThreadTurnService {
    fn default() -> Self {
        Self::new()
    }
}

pub static THREAD_TURN_SERVICE: LazyLock<ThreadTurnService> = LazyLock::new(ThreadTurnService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::task::yield_now;

    fn msg(text: &str) -> PendingMessage {
        msg_with(text, &[])
    }

    fn msg_with(text: &str, attachment_ids: &[&str]) -> PendingMessage {
        PendingMessage {
            id: format!("msg-{text}"),
            text: text.to_string(),
            attachment_ids: attachment_ids.iter().map(|id| id.to_string()).collect(),
            agent_message: None,
        }
    }

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn next_thread() -> String {
        format!("thread-{}", SEQ.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn service() -> &'static ThreadTurnService {
        &THREAD_TURN_SERVICE
    }

    /// Claim a thread, failing the test if it was already taken.
    fn claim(thread: &str) -> ThreadClaim {
        service()
            .claim_or_offer(thread, msg("take the thread"))
            .expect("the thread is free")
    }

    /// Lets every spawned task run as far as it can.
    async fn settle() {
        for _ in 0..10 {
            yield_now().await;
        }
    }

    #[tokio::test]
    async fn serializes_turns_on_the_same_thread_fifo() {
        let thread = next_thread();
        let order = Arc::new(Mutex::new(Vec::<&str>::new()));
        let (release, held) = oneshot::channel::<()>();

        let a = tokio::spawn({
            let (thread, order) = (thread.clone(), Arc::clone(&order));
            async move {
                service()
                    .run(&thread, async {
                        order.lock().push("a:start");
                        let _ = held.await;
                        order.lock().push("a:end");
                    })
                    .await
            }
        });
        settle().await;
        let b = tokio::spawn({
            let (thread, order) = (thread.clone(), Arc::clone(&order));
            async move {
                service()
                    .run(&thread, async { order.lock().push("b:start") })
                    .await
            }
        });

        // b must not have started while a holds the thread.
        settle().await;
        assert_eq!(*order.lock(), vec!["a:start"]);

        release.send(()).unwrap();
        a.await.unwrap();
        b.await.unwrap();
        assert_eq!(*order.lock(), vec!["a:start", "a:end", "b:start"]);
    }

    #[tokio::test]
    async fn runs_turns_on_different_threads_concurrently() {
        let one = next_thread();
        let two = next_thread();
        let (release, held) = oneshot::channel::<()>();
        let a = tokio::spawn({
            let one = one.clone();
            async move { service().run(&one, async { held.await.ok() }).await }
        });
        settle().await;
        let ran = service().run(&two, async { true }).await;
        assert!(ran);
        release.send(()).unwrap();
        a.await.unwrap();
    }

    #[tokio::test]
    async fn does_not_let_a_failed_turn_poison_the_next_waiter() {
        let thread = next_thread();
        let boom: anyhow::Result<()> = service()
            .run(&thread, async { Err(anyhow::anyhow!("turn blew up")) })
            .await;
        let after = service().run(&thread, async { "ran anyway" }).await;
        assert_eq!(boom.unwrap_err().to_string(), "turn blew up");
        assert_eq!(after, "ran anyway");
        assert!(!service().is_tracked(&thread));
    }

    #[tokio::test]
    async fn serializes_a_claimed_turn_against_a_plain_one() {
        let thread = next_thread();
        let order = Arc::new(Mutex::new(Vec::<&str>::new()));
        let (release, held) = oneshot::channel::<()>();
        let goal = tokio::spawn({
            let (thread, order) = (thread.clone(), Arc::clone(&order));
            async move {
                service()
                    .run(&thread, async {
                        order.lock().push("goal:start");
                        let _ = held.await;
                        order.lock().push("goal:end");
                    })
                    .await
            }
        });
        settle().await;
        let taken = claim(&thread);
        let chat = tokio::spawn({
            let order = Arc::clone(&order);
            async move {
                taken
                    .run(async {
                        order.lock().push("chat:start");
                        Ok(())
                    })
                    .await
            }
        });
        settle().await;
        assert_eq!(*order.lock(), vec!["goal:start"]);
        release.send(()).unwrap();
        goal.await.unwrap();
        chat.await.unwrap().unwrap();
        assert_eq!(*order.lock(), vec!["goal:start", "goal:end", "chat:start"]);
    }

    #[test]
    fn takes_a_free_thread() {
        let thread = next_thread();
        let taken = claim(&thread);
        assert!(service().is_claimed(&thread));
        // Our own message is the turn's prompt, not something to hand over.
        assert_eq!(service().pending_count(&thread), 0);
        assert!(taken.drain_or_release().unwrap().is_empty());
    }

    #[test]
    fn hands_the_message_over_the_instant_the_thread_is_claimed() {
        let thread = next_thread();
        let taken = claim(&thread);
        assert!(
            service()
                .claim_or_offer(&thread, msg("no need to run tests"))
                .is_none()
        );
        assert_eq!(
            taken.drain(None).unwrap(),
            vec![msg("no need to run tests")]
        );
        assert!(taken.drain_or_release().unwrap().is_empty());
    }

    #[test]
    fn carries_the_handed_over_message_attachment_ids() {
        let thread = next_thread();
        let taken = claim(&thread);
        service().claim_or_offer(&thread, msg_with("look at this log", &["att-1", "att-2"]));
        assert_eq!(
            taken.drain(None).unwrap(),
            vec![msg_with("look at this log", &["att-1", "att-2"])]
        );
        assert!(taken.drain_or_release().unwrap().is_empty());
    }

    #[test]
    fn takes_the_thread_again_once_the_claim_ended() {
        let thread = next_thread();
        claim(&thread).drain_or_release().unwrap();
        let again = service().claim_or_offer(&thread, msg("a turn of my own"));
        assert!(again.is_some());
        again.unwrap().end();
    }

    #[tokio::test]
    async fn collects_messages_while_the_claiming_turn_waits_for_the_mutex() {
        let thread = next_thread();
        let (release, held) = oneshot::channel::<()>();
        let goal = tokio::spawn({
            let thread = thread.clone();
            async move { service().run(&thread, async { held.await.ok() }).await }
        });
        settle().await;

        let taken = claim(&thread);
        assert!(
            service()
                .claim_or_offer(&thread, msg("while queued"))
                .is_none()
        );
        let chat = tokio::spawn({
            let taken = taken.clone();
            async move { taken.run(async { taken.drain(None) }).await }
        });
        settle().await;
        release.send(()).unwrap();
        goal.await.unwrap();
        assert_eq!(chat.await.unwrap().unwrap(), vec![msg("while queued")]);
    }

    #[tokio::test]
    async fn claim_when_free_takes_a_free_thread_at_once() {
        let thread = next_thread();
        let taken = service().claim_when_free(&thread).await;
        assert!(service().is_claimed(&thread));
        taken.end();
        assert!(!service().is_tracked(&thread));
    }

    #[tokio::test]
    async fn claim_when_free_waits_for_the_owner_and_takes_the_thread_as_it_releases() {
        let thread = next_thread();
        let owner = claim(&thread);
        let waiting = tokio::spawn({
            let thread = thread.clone();
            async move { service().claim_when_free(&thread).await }
        });
        settle().await;
        assert!(!waiting.is_finished());

        assert!(owner.drain_or_release().unwrap().is_empty());
        // No message can take the thread between the two claims.
        assert!(
            service()
                .claim_or_offer(&thread, msg("a new message"))
                .is_none()
        );
        let waited = waiting.await.unwrap();
        assert_eq!(waited.drain(None).unwrap(), vec![msg("a new message")]);
        waited.end();
        assert!(!service().is_tracked(&thread));
    }

    #[test]
    fn rejects_an_offer_when_no_turn_owns_the_thread() {
        let thread = next_thread();
        assert!(!service().offer(&thread, msg("hello")));
        assert_eq!(service().pending_count(&thread), 0);
        assert!(!service().is_claimed(&thread));
        assert!(!service().is_tracked(&thread));
    }

    #[test]
    fn accepts_an_offer_while_a_turn_owns_the_thread() {
        let thread = next_thread();
        let other = next_thread();
        let taken = claim(&thread);
        assert!(service().offer(&thread, msg("skip the tests")));
        assert!(!service().offer(&other, msg("other thread")));
        assert_eq!(service().pending_count(&thread), 1);
        assert_eq!(
            taken.drain_or_release().unwrap(),
            vec![msg("skip the tests")]
        );
        taken.end();
    }

    #[test]
    fn withdraws_a_message_the_owning_turn_has_not_drained() {
        let thread = next_thread();
        let taken = claim(&thread);
        let first = msg("keep me");
        let doomed = msg("withdraw me");
        let last = msg("keep me too");
        for m in [&first, &doomed, &last] {
            service().offer(&thread, m.clone());
        }
        assert!(service().withdraw(&thread, &doomed));
        assert_eq!(taken.drain_or_release().unwrap(), vec![first, last]);
        taken.end();
    }

    #[test]
    fn reports_false_once_the_turn_has_taken_the_message() {
        let thread = next_thread();
        let taken = claim(&thread);
        let handed = msg("already injected");
        service().offer(&thread, handed.clone());
        taken.drain(None).unwrap();
        assert!(!service().withdraw(&thread, &handed));
        assert!(!service().withdraw(&next_thread(), &msg("nothing here")));
        taken.end();
    }

    #[test]
    fn hands_over_pending_messages_in_arrival_order_and_keeps_the_claim() {
        let thread = next_thread();
        let taken = claim(&thread);
        service().offer(&thread, msg("first"));
        service().offer(&thread, msg("second"));
        assert_eq!(
            taken.drain(None).unwrap(),
            vec![msg("first"), msg("second")]
        );
        assert_eq!(service().pending_count(&thread), 0);
        // The turn is between steps, not finished: the next message is still its.
        assert!(service().is_claimed(&thread));
        assert!(service().offer(&thread, msg("and another")));
        assert_eq!(taken.drain_or_release().unwrap(), vec![msg("and another")]);
        assert!(service().is_claimed(&thread));
        assert!(taken.drain_or_release().unwrap().is_empty());
    }

    #[test]
    fn releases_the_thread_when_nothing_is_pending() {
        let thread = next_thread();
        let taken = claim(&thread);
        assert!(taken.drain_or_release().unwrap().is_empty());
        assert!(!service().is_claimed(&thread));
        assert!(!service().offer(&thread, msg("too late")));
        assert!(!service().is_tracked(&thread));
    }

    #[tokio::test]
    async fn releases_the_claim_when_the_turn_returns_and_clears_what_it_never_drained() {
        let thread = next_thread();
        let taken = claim(&thread);
        taken
            .run(async {
                assert!(service().is_claimed(&thread));
                service().offer(&thread, msg("never taken"));
                Ok(())
            })
            .await
            .unwrap();
        assert!(!service().is_claimed(&thread));
        assert_eq!(service().pending_count(&thread), 0);
        assert!(!service().is_tracked(&thread));
    }

    #[tokio::test]
    async fn clears_leftovers_when_the_turn_fails() {
        let thread = next_thread();
        let taken = claim(&thread);
        let failed: anyhow::Result<()> = taken
            .run(async {
                service().offer(&thread, msg("orphaned by the throw"));
                Err(anyhow::anyhow!("invoke blew up"))
            })
            .await;
        assert_eq!(failed.unwrap_err().to_string(), "invoke blew up");
        assert!(!service().is_claimed(&thread));
        assert_eq!(service().pending_count(&thread), 0);
    }

    #[tokio::test]
    async fn hands_back_what_no_turn_took_to_an_exchange_that_ends_early() {
        let thread = next_thread();
        let taken = claim(&thread);
        let abandoned = taken
            .run(async {
                service().offer(&thread, msg("never mind"));
                let abandoned = taken.end();
                assert!(!service().offer(&thread, msg("too late")));
                Ok(abandoned)
            })
            .await
            .unwrap();
        assert_eq!(abandoned, vec![msg("never mind")]);
        assert!(taken.end().is_empty());
        assert!(!service().is_tracked(&thread));
    }

    #[tokio::test]
    async fn does_not_hand_one_turns_leftovers_to_the_next_turn() {
        let thread = next_thread();
        let first = claim(&thread);
        first
            .run(async {
                service().offer(&thread, msg("from the first turn"));
                Ok(())
            })
            .await
            .unwrap();
        let second = claim(&thread);
        let seen = second.run(async { second.drain(None) }).await.unwrap();
        assert!(seen.is_empty());
    }

    #[tokio::test]
    async fn lets_the_next_message_take_the_thread_while_the_closed_claim_still_runs() {
        let thread = next_thread();
        let first = claim(&thread);
        let (release, held) = oneshot::channel::<()>();
        let running = tokio::spawn({
            let first = first.clone();
            async move { first.run(async { Ok(held.await.ok()) }).await }
        });
        settle().await;

        first.close();

        assert!(!service().offer(&thread, msg("after the stop")));
        let second = service()
            .claim_or_offer(&thread, msg("a turn of its own"))
            .expect("the thread is free again");
        release.send(()).unwrap();
        running.await.unwrap().unwrap();
        // The closed claim's release leaves the next claim in place.
        assert!(service().is_claimed(&thread));
        assert!(service().offer(&thread, msg("steers the second turn")));
        assert_eq!(
            second.drain(None).unwrap(),
            vec![msg("steers the second turn")]
        );
        second.end();
    }

    #[test]
    fn keeps_what_was_handed_over_before_the_close_with_the_closed_claim() {
        let thread = next_thread();
        let first = claim(&thread);
        service().offer(&thread, msg("before the stop"));
        first.close();
        let second = claim(&thread);
        service().offer(&thread, msg("after the stop"));
        assert_eq!(first.end(), vec![msg("before the stop")]);
        assert_eq!(second.drain(None).unwrap(), vec![msg("after the stop")]);
        second.end();
        assert!(!service().is_tracked(&thread));
    }

    #[tokio::test]
    async fn gives_the_thread_to_a_caller_waiting_for_it_at_the_close() {
        let thread = next_thread();
        let first = claim(&thread);
        let waiting = tokio::spawn({
            let thread = thread.clone();
            async move { service().claim_when_free(&thread).await }
        });
        settle().await;
        first.close();
        let next = waiting.await.unwrap();
        assert!(service().is_claimed(&thread));
        first.end();
        assert!(service().is_claimed(&thread));
        next.end();
        assert!(!service().is_tracked(&thread));
    }

    #[test]
    fn withdraws_a_message_from_a_closed_claim() {
        let thread = next_thread();
        let first = claim(&thread);
        let handed = msg("withdrawn");
        service().offer(&thread, handed.clone());
        first.close();
        assert!(service().withdraw(&thread, &handed));
        assert!(first.end().is_empty());
    }

    #[test]
    fn takes_the_selected_messages_and_keeps_the_rest_in_order() {
        let thread = next_thread();
        let taken = claim(&thread);
        for text in ["a", "b", "c"] {
            service().offer(&thread, msg(text));
        }
        let only_b = |m: &PendingMessage| m.text == "b";
        assert_eq!(taken.drain(Some(&only_b)).unwrap(), vec![msg("b")]);
        assert_eq!(taken.drain(None).unwrap(), vec![msg("a"), msg("c")]);
        taken.end();
    }

    #[tokio::test]
    async fn rejects_a_claim_used_after_it_ended() {
        let thread = next_thread();
        let taken = claim(&thread);
        taken.run(async { Ok(()) }).await.unwrap();
        let ended = format!("after the claim on thread {thread} ended");
        assert!(taken.drain(None).unwrap_err().to_string().contains(&ended));
        assert!(
            taken
                .drain_or_release()
                .unwrap_err()
                .to_string()
                .contains(&ended)
        );
        assert!(
            taken
                .run(async { Ok(()) })
                .await
                .unwrap_err()
                .to_string()
                .contains(&ended)
        );
        assert!(!service().is_claimed(&thread));
    }
}
