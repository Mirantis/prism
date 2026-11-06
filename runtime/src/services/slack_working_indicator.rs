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
    status_op_chains: Mutex<HashMap<String, Shared<BoxFuture<'static, bool>>>>,
    /// Set by `stop_all()`; from then on `begin()` returns an inert handle.
    stopped: AtomicBool,
}

impl SlackWorkingIndicator {
    pub fn new(ops: Arc<dyn SlackIndicatorOps>) -> Self {
        SlackWorkingIndicator {
            ops,
            status_entries: Mutex::new(HashMap::new()),
            active_handles: Mutex::new(HashMap::new()),
            status_op_chains: Mutex::new(HashMap::new()),
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
        todo!()
    }

    /// Set the thread's current status again after the adapter posted a message
    /// into it — Slack clears the assistant status on any bot post, including
    /// mid-turn intermediate replies. No-op when no turn is live on the thread,
    /// and once the thread's initial set failed. The final reply also sets it;
    /// `end()`'s clear lands after it on the same per-key op chain, so the final
    /// state stays cleared.
    pub fn set_status(&self, team_id: &str, channel_id: &str, thread_ts: &str) {
        todo!()
    }

    /// End every live handle (used at adapter shutdown, while clients are still up).
    pub async fn stop_all(&self) {
        todo!()
    }

    fn status_key(&self, team_id: &str, channel_id: &str, thread_ts: &str) -> String {
        format!("{team_id}:{channel_id}:{thread_ts}")
    }
}
