//! Context-window occupancy tracking (channel-agnostic).
//!
//! Answers "how much of the model's context window is this thread using?" so the
//! clients can show a context-window indicator (% of the window consumed).
//!
//! The numerator comes from the provider, not from an estimate. The AI SDK's
//! `usage.input_tokens` is the full prompt size *including* cached tokens — the
//! Anthropic provider sets it to `input_tokens + cache_creation + cache_read`, and
//! the SDK core flattens that to a single number. So it must NOT have cache
//! read/write added on top; that would double-count, badly, because `invoke.rs`
//! sets four cache breakpoints and cache reads dominate a warm thread.
//!
//! Note the distinction from `InvokeResponse.usage.total_tokens`, which sums every
//! step: each agentic step resends the whole conversation, so that figure is
//! cumulative *billed* spend, not occupancy.
//!
//! Occupancy here is the latest step's prompt **plus that step's output** — i.e.
//! how full the context will be when the next turn starts, since the reply becomes
//! part of the next prompt. Deliberately not the prompt alone: at the moment the
//! number matters most, the reply is exactly what pushed it there. Don't "simplify"
//! this to `input_tokens` to match a narrower reading of the word occupancy; that
//! silently changes the metric.
//!
//! Nothing here knows about WebSockets — snapshots are announced on `events`
//! and transports subscribe, matching `thread_title_service.rs`.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

pub use crate::lib::context_window::ContextUsageSnapshot;

/// A thread's occupancy changed — emitted as `usage`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsageEvent {
    pub user_id: String,
    #[serde(flatten)]
    pub snapshot: ContextUsageSnapshot,
}

/// One step's measurement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordInput {
    /// Carried only so the `usage` event can be routed to that user's clients.
    pub user_id: String,
    pub thread_id: String,
    pub model_id: String,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
}

/// A post-compaction occupancy estimate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EstimateInput {
    pub user_id: String,
    pub thread_id: String,
    pub model_id: String,
    pub used_tokens: i64,
}

/// A thread's latest measurement, stored for every model: idle compaction reads the
/// size after a restart. `snapshot` is `None` when the model's window is unknown.
#[derive(Debug, Clone)]
struct TrackedThread {
    model_id: String,
    used_tokens: i64,
    snapshot: Option<ContextUsageSnapshot>,
}

/// Receives each `usage` event.
pub type ContextUsageListener = Arc<dyn Fn(&ContextUsageEvent) + Send + Sync>;

/// The `usage` events: a thread's occupancy changed.
#[derive(Default)]
pub struct ContextUsageEvents {
    usage: RwLock<Vec<ContextUsageListener>>,
}

impl ContextUsageEvents {
    /// Call `listener` with every usage event from now on.
    pub fn on_usage(&self, listener: impl Fn(&ContextUsageEvent) + Send + Sync + 'static) {
        self.usage.write().push(Arc::new(listener));
    }

    /// Hand `event` to every listener, synchronously and in subscription order.
    pub fn emit_usage(&self, event: &ContextUsageEvent) {
        let listeners = self.usage.read().clone();
        for listener in listeners {
            listener(event);
        }
    }
}

pub struct ContextUsageService {
    pub events: ContextUsageEvents,
    /// Keyed by threadId. Bounded by concurrent in-flight turns (goal runs are
    /// already serialized per thread), and each entry is dropped by `finalize`.
    tracked: Mutex<HashMap<String, TrackedThread>>,
}

impl ContextUsageService {
    pub fn new() -> Self {
        Self {
            events: ContextUsageEvents::default(),
            tracked: Mutex::new(HashMap::new()),
        }
    }

    /// Record one step's measurement. Called per step finish, so it stays cheap:
    /// no I/O, and it only emits when the rounded percentage actually moved —
    /// otherwise a 100-step turn would push 100 identical frames.
    ///
    /// Returns the snapshot, or `None` when occupancy can't be determined (the
    /// provider reported no usage, or the model's window is unknown). A `None` means
    /// *render nothing* — never a reassuring 0% used, which would be a claim we
    /// can't back.
    pub fn record(&self, input: RecordInput) -> Option<ContextUsageSnapshot> {
        todo!()
    }

    /// Persist the turn's final measurement. One write per turn rather than per step.
    /// The meter, Auto tier selection and idle compaction after a restart read it. A DB
    /// error is logged (`[ContextUsage] failed to persist snapshot`) and swallowed,
    /// since the next turn writes the column again.
    pub async fn finalize(&self, thread_id: &str) {
        todo!()
    }

    /// Rebuild a snapshot from the columns stored on a thread, for read paths (a
    /// page reload or a resumed CLI session). Recomputes the percentage against
    /// `context_model`'s window rather than the agent's current model, so a stale
    /// measurement is never reinterpreted against a different window.
    pub fn from_stored(
        &self,
        thread_id: &str,
        context_tokens: Option<i64>,
        context_model: Option<&str>,
    ) -> Option<ContextUsageSnapshot> {
        crate::lib::context_window::build_context_snapshot(thread_id, context_model, context_tokens)
    }

    /// Drop in-flight state for a thread without persisting (e.g. thread deleted).
    pub fn forget(&self, thread_id: &str) {
        self.tracked.lock().remove(thread_id);
    }

    /// Apply a post-compaction occupancy estimate: emit a usage frame so the
    /// clients' meters drop immediately, and persist it as the thread's stored
    /// snapshot so a reload shows the same number. The estimate (chars/4 over the
    /// rebuilt context) undershoots the real prompt — it ignores the system prompt
    /// and tools — and self-corrects on the next turn's provider-reported usage.
    ///
    /// Deliberately does not touch the per-turn `tracked` map: compaction runs
    /// under the thread mutex, so no turn is in flight for this thread and there
    /// is no entry to reconcile. The write runs in the background; a failure is
    /// logged (`[ContextUsage] failed to persist estimate`).
    ///
    /// When the model's window is unknown it persists the estimate, emits nothing and
    /// returns `None`. It never reports a made-up percent.
    pub fn apply_estimate(&self, input: EstimateInput) -> Option<ContextUsageSnapshot> {
        todo!()
    }
}

impl Default for ContextUsageService {
    fn default() -> Self {
        Self::new()
    }
}

pub static CONTEXT_USAGE_SERVICE: LazyLock<ContextUsageService> =
    LazyLock::new(ContextUsageService::new);
