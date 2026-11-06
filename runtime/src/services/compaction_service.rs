//! Conversation compaction (channel-agnostic).
//!
//! Folds a thread's older history into one structured summary so the context
//! stays inside the model's window while the newest messages (the tail) remain
//! verbatim. The summary is *anchored*: on re-compaction the previous summary is
//! already in the message array (as the summary message `context_builder.rs`
//! injects), and the prompt folds it into the new, complete summary — so one
//! `compactionSummary` column per thread is the whole persistent state.
//!
//! Three entry points:
//!
//! - `maybe_auto_compact(fork)` — called by `invoke_stream()` after a thread-bound
//!   turn with the turn's own request ingredients (model, cached system parts,
//!   cached tools, live message array). Reusing them makes the summarize call a
//!   "forked request": the provider's prompt cache already holds the
//!   tools+system+history prefix, so the fork is mostly a cache read.
//! - `compact_now()` — the manual `/compact` path (REST) — and the idle path
//!   (`arm_idle`, `restore_idle`) share `compact_rebuilt`. It rebuilds the request from
//!   stored rows with the tool list the next chat turn would declare, so it reads the
//!   tools+system+history prefix a recent turn cached: nothing per-turn sits in the
//!   system prompt (the date changes once a day, and a turn's recalled memories are a
//!   stored row this path replays like any other).
//!
//! All serialize on the per-thread mutex (`THREAD_TURN_SERVICE.run`) so a
//! compaction never rewrites thread state while a turn is building its context.
//! All commit atomically, marking exactly the rows that were in the summarized
//! context (minus the tail) — never "all but last N at commit time" — so a
//! message that lands between fork and commit is never swallowed: it stays
//! uncompacted and verbatim in the next context.
//!
//! Live-read threads (any threadSource but DATABASE): their history is re-read
//! from the channel each turn and the synthesized rows carry hash ids, so row
//! flags cannot hide them. Their compaction instead advances a watermark
//! (`compactedThroughTs`, the newest compacted external message id) that the
//! thread provider passes as `oldest`. Only the interleaved internal-step DB
//! rows are flag-flipped there.
//!
//! Nothing here knows about WebSockets — progress is announced on `events` as
//! `compaction` and transports subscribe, matching `context_usage_service.rs`.
//! Nothing is ever delivered through `MESSAGE_DELIVERY_SERVICE`: compaction is a
//! context-build concern, and a "summarizing…" artifact must never land in a
//! channel or the web chat as a conversation message.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use chrono::{DateTime, Utc};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;

use crate::ai::{LanguageModel, ModelMessage, SystemModelMessage, ToolSet};
use crate::constants::{COMPACTION_TAIL_TOKENS, IDLE_COMPACTION_CACHE_SHARE, MAX_OUTPUT_TOKENS};
use crate::lib::llm_providers::llm_provider::{
    CachePointFragment, CacheTtl, LlmProvider, ProviderOptionsFragment, cache_ttl_ms,
};
use crate::prompts::context_builder::ConversationMessage as HistoryRow;
use crate::services::context_usage_service::ContextUsageSnapshot;
use crate::services::llm_call_service::LlmCallPurpose;

/// One row of the summarized context, as it stood when the request was built.
/// The commit marks exactly these rows (minus the tail) — see the module doc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkRow {
    pub id: String,
    /// Channel-native message id for rows read live from an external channel
    /// (e.g. a message timestamp); `None` for DB-native rows.
    pub external_message_id: Option<String>,
    /// Concise-mode internal steps are real DB rows.
    pub internal_step: bool,
    /// A message the user wrote, not a recalled-memory block stored in a user row. The
    /// kept tail starts on one, so a reply never opens it without its request.
    pub from_user: bool,
    /// The message's text plus its tool calls and results, for sizing the tail
    /// (~4 chars/token), in UTF-16 code units.
    pub content_chars: i64,
}

/// A turn's request ingredients, handed over by `invoke_stream`.
#[derive(Clone)]
pub struct CompactionFork {
    pub user_id: String,
    pub agent_id: String,
    pub thread_id: String,
    pub model_id: String,
    /// The exact model instance the turn used.
    pub model: Arc<dyn LanguageModel>,
    /// The provider's prompt-cache breakpoint fragment.
    pub cache_point: CachePointFragment,
    /// The turn's request-level cache options, which the summary sends too.
    pub cache_request: ProviderOptionsFragment,
    /// cachedSystem — cache breakpoints included.
    pub system: Vec<SystemModelMessage>,
    /// cachedTools — what the summarize call declares (see `declared_tools`).
    pub tools: ToolSet,
    /// Whether the summary request has to send `tools` under tool choice 'auto':
    /// a declared list (`tool_ledger_service.rs`), or deferred tools that history
    /// loads on a vendor whose SDK drops the block under 'none'.
    pub declared_tools: bool,
    /// History as sent, summary message included, without the turn's trailing
    /// tool-change announcements.
    pub messages: Vec<ModelMessage>,
    /// Mid-turn steering messages, in arrival order.
    pub injections: Vec<ModelMessage>,
    /// context.recent_messages at fork time.
    pub context_rows: Vec<ForkRow>,
}

/// The successful-turn variant: carries the reply and the trigger measurement.
#[derive(Clone)]
pub struct AutoCompactFork {
    pub fork: CompactionFork,
    /// This turn's collapsed assistant text (tool calls + results included).
    pub final_assistant_text: String,
    /// The turn's last per-step occupancy snapshot (a trigger-only fallback is legal).
    pub snapshot: ContextUsageSnapshot,
}

/// Where a compaction is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CompactionStatus {
    Started,
    Completed,
    Failed,
    /// A benign no-op (nothing to compact), kept distinct from `Failed` so it
    /// neither reads as an error in the UI nor counts toward the failure metric.
    Skipped,
}

/// What started a compaction, as clients are told.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CompactionTrigger {
    Auto,
    Manual,
}

impl CompactionTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            CompactionTrigger::Auto => "auto",
            CompactionTrigger::Manual => "manual",
        }
    }
}

/// Telemetry-only refinement of the trigger: what actually fired the job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum CompactionReason {
    Threshold,
    Overflow,
    Manual,
    Idle,
}

impl CompactionReason {
    fn as_str(self) -> &'static str {
        match self {
            CompactionReason::Threshold => "threshold",
            CompactionReason::Overflow => "overflow",
            CompactionReason::Manual => "manual",
            CompactionReason::Idle => "idle",
        }
    }
}

/// Emitted as `compaction` on `events`; broadcast to clients verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionEvent {
    pub user_id: String,
    pub thread_id: String,
    pub status: CompactionStatus,
    pub trigger: CompactionTrigger,
    /// Present (possibly null) on a completed compaction.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_before: Option<Option<i64>>,
    /// chars/4 estimate over the rebuilt context; null when the window is unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_after: Option<Option<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages_compacted: Option<i64>,
    /// Failed only. Exception text — never the summary.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Skipped only. Why there was nothing to do.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Completed only: the conversation was compacted while it sat idle. Only ever `true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle: Option<bool>,
}

/// The thread a compaction runs on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleInput {
    pub user_id: String,
    pub agent_id: String,
    pub thread_id: String,
}

/// A chat turn that may arm idle compaction.
pub struct ArmIdleInput<'a> {
    pub thread: IdleInput,
    pub provider: &'a LlmProvider,
    pub model_id: String,
    pub used_tokens: i64,
}

/// A pending idle compaction, and the time after which a call on the thread cancels it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct IdleDue {
    thread: IdleInput,
    after: DateTime<Utc>,
}

/// The rows a compaction keeps verbatim, and the ones before them it summarizes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailSplit {
    pub compactable: Vec<ForkRow>,
    pub tail: Vec<ForkRow>,
}

/// One finished summary, before it is committed: the report plus the rows it covers.
struct CompleteInput {
    user_id: String,
    agent_id: String,
    thread_id: String,
    trigger: CompactionTrigger,
    reason: CompactionReason,
    model_id: String,
    thread_source: String,
    tokens_before: Option<i64>,
    summary: String,
    rows: Vec<ForkRow>,
}

/// A committed summary, as `finish` reports it.
struct FinishInput {
    user_id: String,
    agent_id: String,
    thread_id: String,
    trigger: CompactionTrigger,
    reason: CompactionReason,
    model_id: String,
    thread_source: String,
    tokens_before: Option<i64>,
    summary: String,
    messages_compacted: i64,
    /// The rows the commit kept verbatim.
    tail: Vec<ForkRow>,
}

/// Receives each `compaction` event.
pub type CompactionListener = Arc<dyn Fn(&CompactionEvent) + Send + Sync>;

/// Receives the thread id of each compaction that ended, queued or running.
pub type SettledListener = Arc<dyn Fn(&str) + Send + Sync>;

/// The `compaction` events, and `settled` when a thread's compaction ends.
#[derive(Default)]
pub struct CompactionEvents {
    compaction: RwLock<Vec<CompactionListener>>,
    settled: RwLock<Vec<SettledListener>>,
}

impl CompactionEvents {
    /// Call `listener` with every compaction event from now on.
    pub fn on_compaction(&self, listener: impl Fn(&CompactionEvent) + Send + Sync + 'static) {
        self.compaction.write().push(Arc::new(listener));
    }

    /// Call `listener` with the thread id of every compaction that ends from now on.
    pub fn on_settled(&self, listener: impl Fn(&str) + Send + Sync + 'static) {
        self.settled.write().push(Arc::new(listener));
    }

    /// Hand `event` to every listener, synchronously and in subscription order.
    pub fn emit_compaction(&self, event: &CompactionEvent) {
        let listeners = self.compaction.read().clone();
        for listener in listeners {
            listener(event);
        }
    }

    /// Hand `thread_id` to every `settled` listener, synchronously and in subscription order.
    pub fn emit_settled(&self, thread_id: &str) {
        let listeners = self.settled.read().clone();
        for listener in listeners {
            listener(thread_id);
        }
    }
}

pub struct CompactionService {
    pub events: CompactionEvents,
    /// Threads with a compaction queued or running. Collapses the coalesced
    /// follow-up turns of one exchange to a single compaction and stops a manual
    /// request from double-queuing behind an auto one.
    in_flight: Mutex<HashSet<String>>,
    /// One timer per idle chat conversation. `restore_idle` re-arms them at boot from
    /// stored data. A thread a session reset left behind still gets its one summary.
    idle_timers: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl CompactionService {
    pub fn new() -> Self {
        Self {
            events: CompactionEvents::default(),
            in_flight: Mutex::new(HashSet::new()),
            idle_timers: Mutex::new(HashMap::new()),
        }
    }

    /// Whether any compaction is currently running.
    pub fn has_in_flight(&self) -> bool {
        !self.in_flight.lock().is_empty()
    }

    /// Ends a thread's queued or running compaction, and emits `settled`.
    fn settle(&self, thread_id: &str) {
        self.in_flight.lock().remove(thread_id);
        self.events.emit_settled(thread_id);
    }

    /// Auto path. Synchronous and never fails — `invoke_stream` calls it on the hot
    /// path right before closing the step stream. All trigger policy lives here so
    /// the caller stays dumb: it hands over the fork unconditionally. The job is
    /// queued on the thread's mutex without waiting for it, so calling from inside
    /// the current turn cannot self-deadlock.
    pub fn maybe_auto_compact(&self, fork: AutoCompactFork) {
        todo!()
    }

    /// Idle path. After a chat turn under `CHAT_CACHE_TTL=1h`, a conversation of at
    /// least `IDLE_COMPACTION_MIN_TOKENS` is compacted once it has sat idle for most of
    /// its cache's lifetime, so the summary reads the turn's warm prefix. Any later
    /// invocation of the thread cancels the timer. The due time comes from stored data
    /// (`restore_idle`), so a restart re-arms it. Synchronous, never fails.
    pub fn arm_idle(&self, input: ArmIdleInput<'_>) {
        todo!()
    }

    /// At boot, re-arm the idle compactions a restart dropped: the conversations used
    /// in the last day whose newest turn was a chat turn, of at least
    /// `IDLE_COMPACTION_MIN_TOKENS`, and not compacted since. One already past its due
    /// time is compacted at once.
    pub async fn restore_idle(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Drops a conversation's idle timer: it has moved on, or is being compacted now.
    pub fn cancel_idle(&self, thread_id: &str) {
        if let Some(timer) = self.idle_timers.lock().remove(thread_id) {
            timer.abort();
        }
    }

    fn schedule_idle(&self, due: IdleDue, delay_ms: i64) {
        todo!()
    }

    /// The idle timer fired: compact the conversation unless a turn or a
    /// compaction since then did the job.
    fn compact_idle(&self, due: IdleDue) {
        todo!()
    }

    /// Overflow recovery. Called by `invoke_stream`'s error path when a turn's
    /// request outgrew the model's context window: that turn never reaches the
    /// threshold hook (it only runs on success), and every later turn rebuilds
    /// the same oversized context — without this, the thread is stuck rejecting
    /// forever. No threshold or window guard on purpose: the provider's own
    /// rejection is stronger evidence than any measured percentage, and it also
    /// covers models whose window we don't know. Synchronous, never fails.
    pub fn maybe_compact_after_overflow(&self, fork: CompactionFork) {
        todo!()
    }

    /// Manual path (`/compact` → REST): a compaction rebuilt from the stored thread
    /// under the thread mutex (see `compact_rebuilt`). A failure is reported as a
    /// `failed` event, never returned.
    pub async fn compact_now(&self, input: IdleInput) {
        todo!()
    }

    /// One compaction whose request is rebuilt from the stored thread, as the next chat
    /// turn would send it, so it reads the prefix that turn's cache holds. Runs under
    /// the thread's lock; the caller owns `in_flight`.
    async fn compact_rebuilt(
        &self,
        input: &IdleInput,
        trigger: CompactionTrigger,
        reason: CompactionReason,
        last_call_at: Option<DateTime<Utc>>,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Cheap REST precheck. Counts DB rows, which is right for DATABASE threads;
    /// live-read threads pass through (their history lives in the channel, and
    /// `compact_now`'s own row check covers them).
    pub async fn has_compactable_history(&self, thread_id: &str) -> anyhow::Result<bool> {
        todo!()
    }

    /// The forked summarize request — see the module doc for the cache story.
    async fn run_auto_compaction(&self, fork: AutoCompactFork) {
        todo!()
    }

    /// Overflow-recovery summarize: like the threshold fork, but the request that
    /// just failed proves the full history + prompt does NOT fit — so on a
    /// context-overflow rejection of the summarize call itself, the oldest
    /// quarter of the history is dropped and the call retried (the array is
    /// re-anchored on a user message so tool-call pairs never split), at most 10
    /// attempts. The commit still marks every fork row minus the tail: rows whose
    /// content fell out of the shrunken summarize input lose their detail, which is
    /// the accepted price of unsticking a thread that otherwise rejects forever.
    /// When even the previous summary has to go, the new one replaces it without
    /// having read it, and the history before it is gone from the context.
    async fn run_overflow_compaction(&self, fork: CompactionFork) {
        todo!()
    }

    /// Shared last step of every runner: commit the summary, report it.
    async fn complete(&self, input: CompleteInput) -> anyhow::Result<()> {
        todo!()
    }

    /// Persist one compaction: the summary + watermark on the thread and the
    /// `isCompacted` flags on exactly `rows` minus the tail, in one transaction —
    /// a summarizer that produced nothing writes nothing.
    ///
    /// DATABASE threads: row flags are authoritative; the watermark is stored as
    /// the newest compacted row's createdAt ISO for observability. Live-read
    /// threads: the watermark (the newest external message id among compacted
    /// rows) is authoritative and only the interleaved internal-step DB rows get
    /// flags — rows read from the channel have synthesized hash ids that match
    /// nothing in the DB.
    async fn commit(
        &self,
        thread_id: &str,
        summary: &str,
        rows: Vec<ForkRow>,
    ) -> anyhow::Result<(i64, Vec<ForkRow>)> {
        todo!()
    }

    /// Shared completion: meter estimate, completed event, finished telemetry.
    async fn finish(&self, input: FinishInput) {
        todo!()
    }

    fn start(&self, user_id: &str, agent_id: &str, thread_id: &str, trigger: CompactionTrigger) {
        todo!()
    }

    /// Terminal no-op: there was nothing to compact. Distinct from `fail()` so a
    /// benign outcome doesn't surface as an error to the user or inflate the
    /// `compaction failed` metric — the one you'd actually alert on.
    fn skip(
        &self,
        user_id: &str,
        agent_id: &str,
        thread_id: &str,
        trigger: CompactionTrigger,
        detail: &str,
    ) {
        todo!()
    }

    fn fail(
        &self,
        user_id: &str,
        agent_id: &str,
        thread_id: &str,
        trigger: CompactionTrigger,
        error: &str,
    ) {
        todo!()
    }
}

impl Default for CompactionService {
    fn default() -> Self {
        Self::new()
    }
}

const CHARS_PER_TOKEN: i64 = 4;

/// How much later than an idle timer's arm time a call row may be stamped and still be the same turn's.
const STALE_TOLERANCE_MS: i64 = 5_000;

/// How far back `restore_idle` looks for a conversation someone still uses.
const IDLE_RESTORE_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// The turns that use a conversation; a newer one than an idle timer's means it moved on.
/// A compaction is known by the thread's `compactedAt`, which its commit writes, so a
/// summary call that a restart stopped before its commit leaves the conversation due.
const THREAD_TURN_PURPOSES: [LlmCallPurpose; 4] = [
    LlmCallPurpose::Chat,
    LlmCallPurpose::Cron,
    LlmCallPurpose::Goal,
    LlmCallPurpose::Webhook,
];

/// Whether idle compaction runs: it and threshold compaction are on, and chat turns
/// ask for the one-hour cache. A five-minute cache has expired long before a person
/// who paused comes back, so there is no warm prefix for the summary to read.
fn idle_compaction_armed() -> bool {
    let config = &*crate::config::CONFIG;
    config.idle_compaction
        && config.compaction_threshold_percent.is_some()
        && config.chat_cache_ttl == CacheTtl::OneHour
}

/// How long a chat conversation on `model_id` sits idle before it is compacted, or
/// `None` when the vendor keeps the cache no longer under `1h` than by default.
fn idle_delay_ms(provider: &LlmProvider, model_id: &str) -> Option<i64> {
    let lifetime_ms = cache_ttl_ms(provider, model_id, CacheTtl::OneHour);
    if lifetime_ms <= cache_ttl_ms(provider, model_id, CacheTtl::FiveMinutes) {
        return None;
    }
    Some((IDLE_COMPACTION_CACHE_SHARE * lifetime_ms as f64) as i64)
}

/// A context's rows as the commit marks them.
pub fn to_fork_rows(messages: &[HistoryRow]) -> Vec<ForkRow> {
    todo!()
}

/// The rows a compaction keeps verbatim, and the ones before them it summarizes.
/// The tail is the longest run of newest rows that starts on a user's message, holds
/// at most `compaction_tail_messages` rows and fits `COMPACTION_TAIL_TOKENS`. The row
/// cap gives way for the newest exchange, since one reply can be many step rows.
/// When even the newest exchange does not fit the token budget, everything is
/// summarized. A thread with no user message keeps its newest rows that fit both.
pub fn split_tail(rows: &[ForkRow]) -> TailSplit {
    let tail_messages = crate::config::CONFIG.compaction_tail_messages;
    if tail_messages == 0 {
        return TailSplit {
            compactable: rows.to_vec(),
            tail: Vec::new(),
        };
    }
    let budget = COMPACTION_TAIL_TOKENS * CHARS_PER_TOKEN;
    // A thread with no user message at all, such as a goal's, has no request to anchor on.
    let anchored = rows.iter().any(|row| row.from_user);
    let mut start = rows.len();
    let mut chars = 0;
    for i in (0..rows.len()).rev() {
        chars += rows[i].content_chars;
        if chars > budget {
            break;
        }
        if (rows.len() - i) as i64 > tail_messages && (start < rows.len() || !anchored) {
            break;
        }
        if rows[i].from_user || !anchored {
            start = i;
        }
    }
    TailSplit {
        compactable: rows[..start].to_vec(),
        tail: rows[start..].to_vec(),
    }
}

/// Room left for the forked request's own additions: the turn's reply and the prompt.
const SUMMARY_REQUEST_MARGIN_TOKENS: i64 = 4_000;
const MIN_SUMMARY_OUTPUT_TOKENS: i64 = 4_096;

/// The summary call's output budget: a chat turn's, which every catalog model
/// accepts. The Anthropic Messages API refuses a request whose input plus
/// `max_tokens` exceeds the window, so a nearly full window gets the room it has
/// left instead.
fn summary_output_budget(window_tokens: Option<i64>, used_tokens: Option<i64>) -> i64 {
    let max_output = MAX_OUTPUT_TOKENS;
    let (Some(window), Some(used)) = (window_tokens.filter(|w| *w != 0), used_tokens) else {
        return max_output;
    };
    // Under the floor the request fails on its size, and overflow recovery takes the thread
    // on its next turn.
    let room = window - used - SUMMARY_REQUEST_MARGIN_TOKENS;
    MIN_SUMMARY_OUTPUT_TOKENS.max(max_output.min(room))
}

/// A summary the commit may use: not empty, and not cut off at the output budget.
/// `Err` holds the failure the user is told.
fn read_summary(text: &str, finish_reason: &str) -> Result<String, String> {
    if finish_reason == "length" {
        return Err(
            "The summary was cut off at the output limit, so nothing was compacted.".to_string(),
        );
    }
    let text = text.trim();
    if text.is_empty() {
        Err("The model returned an empty summary.".to_string())
    } else {
        Ok(text.to_string())
    }
}

fn error_text(err: &anyhow::Error) -> String {
    err.to_string()
}

/// Drop the oldest quarter of a summarize history that did not fit, then
/// re-anchor on a user message: an array sliced mid tool-exchange could start
/// on an assistant tool-call or a dangling tool result, both of which the
/// providers reject. A previous summary opens the history and stays, since it
/// stands for everything before it. Returns `None` when nothing meaningful would
/// remain.
fn shrink_history_head(history: &[ModelMessage]) -> Option<Vec<ModelMessage>> {
    todo!()
}

fn anchor_on_user(messages: &[ModelMessage]) -> Vec<ModelMessage> {
    todo!()
}

/// Whether `message` is the summary message that opens a compacted history.
fn is_summary_message(message: Option<&ModelMessage>) -> bool {
    todo!()
}

pub static COMPACTION_SERVICE: LazyLock<CompactionService> = LazyLock::new(CompactionService::new);
