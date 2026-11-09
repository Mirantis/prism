//! Slack Working Indicator
//!
//! Visible "working" cue while a user-initiated Slack turn runs:
//!
//!  - an assistant-thread status line on the reply thread — the primary cue —
//!    pushed event-driven: set at begin, set again whenever the text changes
//!    (a tool starts or finishes) and after each message the adapter posts
//!    into the thread (Slack clears the status on any bot post), and cleared
//!    when the turn ends — Slack never expires it otherwise, so every exit
//!    path must clear it explicitly or it sticks forever. A thread whose
//!    initial set fails is on the fallback cue for the rest of the turn, so
//!    its later pushes are skipped instead of re-attempted; only the final
//!    clear still goes out; and
//!  - an `eyes` reaction on the triggering user message — the fallback cue:
//!    added only when the thread's initial set_status fails, or right away
//!    when the turn has no status thread at all (a top-level DM). The
//!    fallback decision is made once per status entry, so a steered turn
//!    sharing the thread shares the outcome and a re-set failing later never
//!    adds a late reaction. The reaction is removed when the turn ends — only
//!    if it was added, and never swapped for a success or failure emoji. On
//!    the fallback path it appears one Slack round trip after the turn starts.
//!
//! The Slack API calls are injected as [`SlackIndicatorOps`]. `set_status`
//! is expected to fail when the status cannot be set — that failure is
//! the fallback signal; the reaction ops are expected to swallow their own
//! errors. This module still guards every call so a misbehaving op can
//! neither fail a turn nor produce an unhandled error.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use async_trait::async_trait;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;

use crate::lib::tool_lifecycle::{
    ToolLifecycleEvent, ToolLifecycleEventType, ToolLifecycleListener,
};

pub const WORKING_REACTION: &str = "eyes";
pub const WORKING_STATUS_TEXT: &str = "is thinking…";

#[async_trait]
pub trait SlackIndicatorOps: Send + Sync {
    async fn add_reaction(
        &self,
        channel_id: &str,
        message_ts: &str,
        team_id: &str,
        emoji: &str,
    ) -> anyhow::Result<()>;
    async fn remove_reaction(
        &self,
        channel_id: &str,
        message_ts: &str,
        team_id: &str,
        emoji: &str,
    ) -> anyhow::Result<()>;
    /// Must fail when the status cannot be set — the reaction-fallback signal.
    async fn set_status(
        &self,
        team_id: &str,
        channel_id: &str,
        thread_ts: &str,
        status: &str,
    ) -> anyhow::Result<()>;
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkingIndicatorTarget {
    pub team_id: String,
    pub channel_id: String,
    /// ts of the triggering user message — reaction target: the fallback cue,
    /// or the only cue when `status_thread_ts` is absent. Absent → no reaction.
    pub message_ts: Option<String>,
    /// Reply-thread ts for the status line. Absent (top-level DM) → no status;
    /// for a DM, never synthesize one from the message ts — that can activate a
    /// Slack assistant thread before the reply exists. A channel mention DOES
    /// pass its own message ts: the reply always lands in that thread.
    pub status_thread_ts: Option<String>,
}

#[async_trait]
pub trait WorkingIndicatorHandle: Send + Sync {
    /// Idempotent: the first call clears the cues, later calls are no-ops.
    async fn end(&self);

    /// Set the live working phrase ("is running kubectl…"); `None` reverts to the
    /// default text. Pushed to Slack immediately when the text changes. No-op
    /// without a status thread or after `end()`.
    fn set_text(&self, text: Option<&str>);
}

/// The live phrase for the running tools: `is running kubectl…`,
/// `is running kubectl and pwd…`, `is running x, y and z…`. Parallel calls of
/// the same tool collapse into one name. Expects at least one name — the
/// caller reverts to the default text (via `set_text(None)`) when none runs.
pub fn tool_status_text(tool_names: &[String]) -> String {
    let mut seen = HashSet::new();
    let names: Vec<&str> = tool_names
        .iter()
        .map(String::as_str)
        .filter(|name| seen.insert(*name))
        .collect();
    let list = if names.len() <= 1 {
        names.first().copied().unwrap_or("").to_string()
    } else {
        format!(
            "{} and {}",
            names[..names.len() - 1].join(", "),
            names[names.len() - 1]
        )
    };
    format!("is running {list}…")
}

/// Mirror a turn's running tools into its status line. Tool calls of one step
/// run concurrently, so mapping each `completed` straight to `set_text(None)`
/// would revert the text to the default while a sibling tool is still in
/// flight. The listener instead tracks the running names (a multiset — the
/// same tool can run twice in one step) and always shows every tool still
/// running, reverting only when none is.
pub fn create_tool_status_listener(
    handle: Arc<dyn WorkingIndicatorHandle>,
) -> ToolLifecycleListener {
    let running: Mutex<Vec<String>> = Mutex::new(Vec::new());
    Arc::new(move |event: ToolLifecycleEvent| {
        let text = {
            let mut running = running.lock();
            if event.kind == ToolLifecycleEventType::Started {
                running.push(event.tool_name);
            } else if let Some(index) = running.iter().position(|name| *name == event.tool_name) {
                running.remove(index);
            }
            if running.is_empty() {
                None
            } else {
                Some(tool_status_text(&running))
            }
        };
        handle.set_text(text.as_deref());
    })
}

/// One live status line per Slack thread, shared by every turn running on it.
/// Refcounted so a steered message's fast begin/end never clears the status
/// the owning turn still needs (its ref outlives the steered one).
struct StatusEntry {
    ref_count: usize,
    /// The current status text (default, or a live tool phrase).
    text: String,
    /// Outcome of this entry's initial set_status — the fallback decision, made
    /// once per entry: turns sharing the entry (a steered message) gate their
    /// reaction on the same result, and later re-sets never revisit it. Never
    /// fails.
    status_ok: Shared<BoxFuture<'static, bool>>,
    /// Mirrors a false `status_ok` synchronously, for the push paths to
    /// read. Once the initial set failed the turn is on the reaction fallback
    /// and every later push would fail the same way, so pushing again buys
    /// nothing but rate-limit pressure. Per entry rather than per thread: the
    /// next turn on the thread builds a fresh entry and tries again, so one
    /// transient failure disables the cue for one turn only.
    status_failed: bool,
}

pub struct SlackWorkingIndicator {
    ops: Arc<dyn SlackIndicatorOps>,
    status_entries: Mutex<HashMap<String, Arc<Mutex<StatusEntry>>>>,
    /// Live handles by id, so `stop_all` can end every one.
    active_handles: Mutex<HashMap<u64, Arc<dyn WorkingIndicatorHandle>>>,
    /// In-flight status call per thread key; ops chain onto it (see `run_status_op`).
    status_op_chains: Arc<Mutex<HashMap<String, Shared<BoxFuture<'static, bool>>>>>,
    /// Set by `stop_all()`; from then on `begin()` returns an inert handle.
    stopped: AtomicBool,
}

impl SlackWorkingIndicator {
    pub fn new(ops: Arc<dyn SlackIndicatorOps>) -> Self {
        SlackWorkingIndicator {
            ops,
            status_entries: Mutex::new(HashMap::new()),
            active_handles: Mutex::new(HashMap::new()),
            status_op_chains: Arc::new(Mutex::new(HashMap::new())),
            stopped: AtomicBool::new(false),
        }
    }

    /// Start the cues for one turn. After `stop_all()` the clients are going
    /// away — a cue set now could never be cleared, so this hands back an inert
    /// handle that shows nothing and ends as a no-op.
    ///
    /// The reaction decision runs in the background, so the turn is not
    /// delayed by a Slack round trip. Without a status thread (a top-level DM)
    /// the add is issued at once, as the only cue; with one, the add waits for
    /// the entry's initial set_status and fires only when that failed — unless
    /// the turn already ended. `end()` waits for the decision before removing,
    /// so the remove can never overtake the add.
    pub async fn begin(
        self: &Arc<Self>,
        target: WorkingIndicatorTarget,
    ) -> Arc<dyn WorkingIndicatorHandle> {
        let WorkingIndicatorTarget {
            team_id,
            channel_id,
            message_ts,
            status_thread_ts,
        } = target;
        // After stop_all() the clients are going away — a cue set now could
        // never be cleared, so hand back an inert handle instead.
        if self.stopped.load(Ordering::SeqCst) {
            return Arc::new(InertHandle);
        }

        let entry = status_thread_ts
            .as_deref()
            .map(|ts| self.acquire_status(&team_id, &channel_id, ts));

        // Ending the turn takes the add off the table, so the decision below
        // races the status outcome against this signal — the reaction decision
        // must not sit out a slow or stuck set_status round trip just to learn
        // nothing will be added. The owning turn's clear still queues behind that
        // round trip on the entry's op chain (see release_status); only this
        // decision, and a steered turn's end(), are freed by the race.
        let ended = Arc::new(AtomicBool::new(false));
        let ended_signal = CancellationToken::new();

        // Reaction decision — in the background from begin()'s point of view, so
        // the turn is not delayed by a Slack round trip. Without a status entry
        // (a top-level DM) the add is issued at once, as the only cue; with one,
        // the add waits for the entry's initial set_status and fires only when
        // that failed — unless the turn already ended, where the cue could never
        // be seen and would only have to be removed again. Resolves true iff the
        // add was attempted, and never fails. end() awaits it before removing,
        // so the remove can never overtake the add; and the handle is registered
        // below before this returns, so a stop_all() firing while the decision
        // is in flight still finds and ends this turn.
        let decision = {
            let ops = self.ops.clone();
            let status_ok = entry.as_ref().map(|e| e.lock().status_ok.clone());
            let ended = ended.clone();
            let ended_signal = ended_signal.clone();
            let (team_id, channel_id, message_ts) =
                (team_id.clone(), channel_id.clone(), message_ts.clone());
            async move {
                let Some(message_ts) = message_ts else {
                    return false;
                };
                if let Some(status_ok) = status_ok {
                    let outcome = tokio::select! {
                        biased;
                        ok = status_ok => Some(ok),
                        _ = ended_signal.cancelled() => None,
                    };
                    // Skip on success, on end-before-outcome, and on an end that
                    // lands after the outcome but before this continuation.
                    if outcome != Some(false) || ended.load(Ordering::SeqCst) {
                        return false;
                    }
                }
                safely("reactions.add", async {
                    ops.add_reaction(&channel_id, &message_ts, &team_id, WORKING_REACTION)
                        .await
                })
                .await;
                true
            }
        };
        let reaction_added = tokio::spawn(decision)
            .map(|joined| joined.unwrap_or(false))
            .boxed()
            .shared();

        let id = NEXT_HANDLE_ID.fetch_add(1, Ordering::SeqCst);
        let handle: Arc<dyn WorkingIndicatorHandle> = Arc::new(TurnHandle {
            id,
            indicator: self.clone(),
            team_id,
            channel_id,
            message_ts,
            status_thread_ts,
            entry,
            ended,
            ended_signal,
            reaction_added,
        });
        self.active_handles.lock().insert(id, handle.clone());
        handle
    }

    /// Set the thread's current status again after the adapter posted a message
    /// into it — Slack clears the assistant status on any bot post, including
    /// mid-turn intermediate replies. No-op when no turn is live on the thread,
    /// and once the thread's initial set failed. The final reply also sets it;
    /// `end()`'s clear lands after it on the same per-key op chain, so the final
    /// state stays cleared.
    pub fn set_status(&self, team_id: &str, channel_id: &str, thread_ts: &str) {
        let key = self.status_key(team_id, channel_id, thread_ts);
        let entry = self.status_entries.lock().get(&key).cloned();
        // No entry: no turn is live on the thread. status_failed: the cue cannot
        // come back this turn, so a turn posting N intermediate replies would
        // otherwise issue N more rejected calls, one per post.
        let Some(entry) = entry else {
            return;
        };
        let text = {
            let entry = entry.lock();
            if entry.status_failed {
                return;
            }
            entry.text.clone()
        };
        let _ = self.run_status_op(
            &key,
            "assistant.threads.setStatus",
            self.set_status_op(team_id, channel_id, thread_ts, text),
        );
    }

    /// End every live handle (used at adapter shutdown, while clients are still up).
    pub async fn stop_all(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let handles: Vec<Arc<dyn WorkingIndicatorHandle>> =
            self.active_handles.lock().values().cloned().collect();
        futures::future::join_all(handles.iter().map(|handle| handle.end())).await;
        // end() empties both collections; sweep defensively.
        self.status_entries.lock().clear();
        self.active_handles.lock().clear();
    }

    fn status_key(&self, team_id: &str, channel_id: &str, thread_ts: &str) -> String {
        format!("{team_id}:{channel_id}:{thread_ts}")
    }

    /// The `set_status` call with `status`, ready to run on the op chain.
    fn set_status_op(
        &self,
        team_id: &str,
        channel_id: &str,
        thread_ts: &str,
        status: String,
    ) -> BoxFuture<'static, anyhow::Result<()>> {
        let ops = self.ops.clone();
        let (team_id, channel_id, thread_ts) = (
            team_id.to_string(),
            channel_id.to_string(),
            thread_ts.to_string(),
        );
        async move {
            ops.set_status(&team_id, &channel_id, &thread_ts, &status)
                .await
        }
        .boxed()
    }

    /// Status calls for one thread run strictly in order. Without this, a call
    /// still in flight when the next one is issued can land after it on Slack's
    /// side — a stale clear wiping the status a newer turn just set, or worse, a
    /// set landing after the final clear and leaving a stuck "is thinking…"
    /// behind. Resolves with the op's outcome (true = the op succeeded). The op
    /// runs whether or not anybody waits for it.
    fn run_status_op(
        &self,
        key: &str,
        what: &'static str,
        op: BoxFuture<'static, anyhow::Result<()>>,
    ) -> Shared<BoxFuture<'static, bool>> {
        let mut chains = self.status_op_chains.lock();
        let prev = chains.get(key).cloned();
        let next = async move {
            if let Some(prev) = prev {
                prev.await;
            }
            safely(what, op).await
        }
        .boxed()
        .shared();
        chains.insert(key.to_string(), next.clone());
        drop(chains);

        let driver = next.clone();
        let chains = Arc::clone(&self.status_op_chains);
        let key = key.to_string();
        tokio::spawn(async move {
            driver.clone().await;
            let mut chains = chains.lock();
            if chains
                .get(&key)
                .is_some_and(|current| current.ptr_eq(&driver))
            {
                chains.remove(&key);
            }
        });
        next
    }

    fn acquire_status(
        &self,
        team_id: &str,
        channel_id: &str,
        thread_ts: &str,
    ) -> Arc<Mutex<StatusEntry>> {
        let key = self.status_key(team_id, channel_id, thread_ts);
        if let Some(existing) = self.status_entries.lock().get(&key) {
            existing.lock().ref_count += 1;
            return existing.clone();
        }
        // The initial set doubles as the fallback decision: its outcome is cached
        // on the entry for every turn that shares it. It sends WORKING_STATUS_TEXT
        // rather than the entry's text — the entry does not exist yet, and a
        // set_text racing in behind just queues a correctly-ordered second op.
        let status_ok = self.run_status_op(
            &key,
            "assistant.threads.setStatus",
            self.set_status_op(
                team_id,
                channel_id,
                thread_ts,
                WORKING_STATUS_TEXT.to_string(),
            ),
        );
        let entry = Arc::new(Mutex::new(StatusEntry {
            ref_count: 1,
            text: WORKING_STATUS_TEXT.to_string(),
            status_ok: status_ok.clone(),
            status_failed: false,
        }));
        self.status_entries.lock().insert(key, entry.clone());
        // Log the outcome once per entry (not per push — a long turn should not
        // narrate itself). The status line is write-only on the Slack API, so this
        // is the only signal that the primary cue rendered, and the only place the
        // fallback announces itself; the e2e suite asserts on these phrases.
        let watched = entry.clone();
        let (channel_id, thread_ts) = (channel_id.to_string(), thread_ts.to_string());
        tokio::spawn(async move {
            if status_ok.await {
                log_info!(
                    "Slack thread status accepted (channel={}, thread={})",
                    channel_id,
                    thread_ts
                );
                return;
            }
            watched.lock().status_failed = true;
            log_info!(
                "Slack thread status rejected - falling back to the {} reaction (channel={}, thread={})",
                WORKING_REACTION,
                channel_id,
                thread_ts
            );
        });
        entry
    }

    async fn release_status(
        &self,
        team_id: &str,
        channel_id: &str,
        thread_ts: &str,
        entry: &Arc<Mutex<StatusEntry>>,
    ) {
        let key = self.status_key(team_id, channel_id, thread_ts);
        {
            let mut entries = self.status_entries.lock();
            // Identity check: a stale handle must not decrement someone else's entry.
            if !entries
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, entry))
            {
                return;
            }
            let mut held = entry.lock();
            held.ref_count -= 1;
            if held.ref_count > 0 {
                return;
            }
            drop(held);
            entries.remove(&key);
        }
        self.run_status_op(
            &key,
            "assistant.threads.setStatus clear",
            self.set_status_op(team_id, channel_id, thread_ts, String::new()),
        )
        .await;
    }
}

use std::sync::atomic::{AtomicU64, Ordering};

use futures::FutureExt;
use tokio_util::sync::CancellationToken;

use crate::{log_debug, log_info};

static NEXT_HANDLE_ID: AtomicU64 = AtomicU64::new(1);

/// Run an op, swallowing (and debug-logging) any failure. Resolves true when the
/// op succeeded and false when it failed — for set_status, the reaction-fallback
/// signal.
async fn safely(what: &str, op: impl std::future::Future<Output = anyhow::Result<()>>) -> bool {
    match op.await {
        Ok(()) => true,
        Err(error) => {
            log_debug!("Slack working indicator {} failed: {}", what, error);
            false
        }
    }
}

/// Returned by begin() after stop_all(): shows nothing, ends as a no-op.
struct InertHandle;

#[async_trait]
impl WorkingIndicatorHandle for InertHandle {
    async fn end(&self) {}

    fn set_text(&self, _text: Option<&str>) {}
}

/// One turn's cues.
struct TurnHandle {
    id: u64,
    indicator: Arc<SlackWorkingIndicator>,
    team_id: String,
    channel_id: String,
    message_ts: Option<String>,
    status_thread_ts: Option<String>,
    entry: Option<Arc<Mutex<StatusEntry>>>,
    ended: Arc<AtomicBool>,
    ended_signal: CancellationToken,
    /// Whether the reaction was added; never fails.
    reaction_added: Shared<BoxFuture<'static, bool>>,
}

#[async_trait]
impl WorkingIndicatorHandle for TurnHandle {
    async fn end(&self) {
        if self.ended.swap(true, Ordering::SeqCst) {
            return;
        }
        self.ended_signal.cancel();
        self.indicator.active_handles.lock().remove(&self.id);
        let added = self.reaction_added.clone().await;
        if let (Some(entry), Some(thread_ts)) = (&self.entry, &self.status_thread_ts) {
            self.indicator
                .release_status(&self.team_id, &self.channel_id, thread_ts, entry)
                .await;
        }
        if let (true, Some(message_ts)) = (added, &self.message_ts) {
            let ops = self.indicator.ops.clone();
            safely(
                "reactions.remove",
                ops.remove_reaction(
                    &self.channel_id,
                    message_ts,
                    &self.team_id,
                    WORKING_REACTION,
                ),
            )
            .await;
        }
    }

    fn set_text(&self, text: Option<&str>) {
        // status_failed: this thread showed the reaction instead, and the phrase
        // has nowhere to render — pushing it buys another rejection.
        if self.ended.load(Ordering::SeqCst) {
            return;
        }
        let (Some(entry), Some(thread_ts)) = (&self.entry, &self.status_thread_ts) else {
            return;
        };
        let indicator = &self.indicator;
        let key = indicator.status_key(&self.team_id, &self.channel_id, thread_ts);
        // Identity check: a stale handle must not write into a newer turn's entry.
        let current = indicator.status_entries.lock().get(&key).cloned();
        if !current.is_some_and(|current| Arc::ptr_eq(&current, entry)) {
            return;
        }
        let next = text.unwrap_or(WORKING_STATUS_TEXT).to_string();
        {
            let mut entry = entry.lock();
            if entry.status_failed || next == entry.text {
                return;
            }
            entry.text = next.clone();
        }
        let _ = indicator.run_status_op(
            &key,
            "assistant.threads.setStatus",
            indicator.set_status_op(&self.team_id, &self.channel_id, thread_ts, next),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records every call; `set_status` fails while `status_fails` is set.
    #[derive(Default)]
    struct FakeOps {
        calls: Mutex<Vec<String>>,
        status_fails: AtomicBool,
    }

    #[async_trait]
    impl SlackIndicatorOps for FakeOps {
        async fn add_reaction(
            &self,
            channel_id: &str,
            message_ts: &str,
            _team_id: &str,
            emoji: &str,
        ) -> anyhow::Result<()> {
            self.calls
                .lock()
                .push(format!("add {emoji} {channel_id} {message_ts}"));
            Ok(())
        }

        async fn remove_reaction(
            &self,
            channel_id: &str,
            message_ts: &str,
            _team_id: &str,
            emoji: &str,
        ) -> anyhow::Result<()> {
            self.calls
                .lock()
                .push(format!("remove {emoji} {channel_id} {message_ts}"));
            Ok(())
        }

        async fn set_status(
            &self,
            _team_id: &str,
            channel_id: &str,
            thread_ts: &str,
            status: &str,
        ) -> anyhow::Result<()> {
            self.calls
                .lock()
                .push(format!("status {channel_id} {thread_ts} '{status}'"));
            if self.status_fails.load(Ordering::SeqCst) {
                anyhow::bail!("not_allowed");
            }
            Ok(())
        }
    }

    fn target(message_ts: Option<&str>, status_thread_ts: Option<&str>) -> WorkingIndicatorTarget {
        WorkingIndicatorTarget {
            team_id: "T1".into(),
            channel_id: "C1".into(),
            message_ts: message_ts.map(str::to_string),
            status_thread_ts: status_thread_ts.map(str::to_string),
        }
    }

    async fn settle() {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn shows_the_status_line_and_clears_it_when_the_turn_ends() {
        let ops = Arc::new(FakeOps::default());
        let indicator = Arc::new(SlackWorkingIndicator::new(ops.clone()));
        let handle = indicator.begin(target(Some("1.1"), Some("1.0"))).await;
        settle().await;
        handle.set_text(Some("is running kubectl…"));
        settle().await;
        handle.end().await;
        handle.end().await;
        assert_eq!(
            *ops.calls.lock(),
            vec![
                "status C1 1.0 'is thinking…'",
                "status C1 1.0 'is running kubectl…'",
                "status C1 1.0 ''",
            ]
        );
    }

    #[tokio::test]
    async fn falls_back_to_the_reaction_when_the_status_is_refused() {
        let ops = Arc::new(FakeOps::default());
        ops.status_fails.store(true, Ordering::SeqCst);
        let indicator = Arc::new(SlackWorkingIndicator::new(ops.clone()));
        let handle = indicator.begin(target(Some("1.1"), Some("1.0"))).await;
        settle().await;
        // The thread is on the fallback, so a new phrase is not pushed.
        handle.set_text(Some("is running kubectl…"));
        indicator.set_status("T1", "C1", "1.0");
        settle().await;
        handle.end().await;
        assert_eq!(
            *ops.calls.lock(),
            vec![
                "status C1 1.0 'is thinking…'",
                "add eyes C1 1.1",
                "status C1 1.0 ''",
                "remove eyes C1 1.1",
            ]
        );
    }

    #[tokio::test]
    async fn a_top_level_dm_gets_the_reaction_alone() {
        let ops = Arc::new(FakeOps::default());
        let indicator = Arc::new(SlackWorkingIndicator::new(ops.clone()));
        let handle = indicator.begin(target(Some("1.1"), None)).await;
        handle.end().await;
        assert_eq!(
            *ops.calls.lock(),
            vec!["add eyes C1 1.1", "remove eyes C1 1.1"]
        );
    }

    #[tokio::test]
    async fn a_steered_turn_leaves_the_status_to_the_turn_that_owns_it() {
        let ops = Arc::new(FakeOps::default());
        let indicator = Arc::new(SlackWorkingIndicator::new(ops.clone()));
        let owner = indicator.begin(target(Some("1.1"), Some("1.0"))).await;
        let steered = indicator.begin(target(Some("1.2"), Some("1.0"))).await;
        steered.end().await;
        settle().await;
        assert_eq!(*ops.calls.lock(), vec!["status C1 1.0 'is thinking…'"]);
        owner.end().await;
        assert_eq!(ops.calls.lock().last().unwrap(), "status C1 1.0 ''");
    }

    #[tokio::test]
    async fn stop_all_ends_every_turn_and_refuses_new_ones() {
        let ops = Arc::new(FakeOps::default());
        let indicator = Arc::new(SlackWorkingIndicator::new(ops.clone()));
        let _handle = indicator.begin(target(None, Some("1.0"))).await;
        indicator.stop_all().await;
        let inert = indicator.begin(target(Some("2.1"), Some("2.0"))).await;
        inert.end().await;
        assert_eq!(
            *ops.calls.lock(),
            vec!["status C1 1.0 'is thinking…'", "status C1 1.0 ''"]
        );
    }

    #[test]
    fn names_the_running_tools() {
        let names = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            tool_status_text(&names(&["kubectl"])),
            "is running kubectl…"
        );
        assert_eq!(
            tool_status_text(&names(&["kubectl", "pwd", "kubectl"])),
            "is running kubectl and pwd…"
        );
        assert_eq!(
            tool_status_text(&names(&["x", "y", "z"])),
            "is running x, y and z…"
        );
    }

    #[tokio::test]
    async fn the_tool_listener_shows_every_tool_still_running() {
        let ops = Arc::new(FakeOps::default());
        let indicator = Arc::new(SlackWorkingIndicator::new(ops.clone()));
        let handle = indicator.begin(target(None, Some("1.0"))).await;
        let listener = create_tool_status_listener(handle.clone());
        let event = |kind, name: &str| ToolLifecycleEvent {
            kind,
            tool_name: name.to_string(),
        };
        listener(event(ToolLifecycleEventType::Started, "a"));
        listener(event(ToolLifecycleEventType::Started, "b"));
        listener(event(ToolLifecycleEventType::Completed, "a"));
        listener(event(ToolLifecycleEventType::Completed, "b"));
        settle().await;
        handle.end().await;
        assert_eq!(
            *ops.calls.lock(),
            vec![
                "status C1 1.0 'is thinking…'",
                "status C1 1.0 'is running a…'",
                "status C1 1.0 'is running a and b…'",
                "status C1 1.0 'is running b…'",
                "status C1 1.0 'is thinking…'",
                "status C1 1.0 ''",
            ]
        );
    }
}
