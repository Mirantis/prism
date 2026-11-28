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
//! - `compact_now()` — the manual `/compact` path (REST) — the idle path
//!   (`arm_idle`, `restore_idle`) and the stored-run path (`after_message_stored`, for
//!   rows a run without a turn in the conversation stores) share `compact_rebuilt`.
//!   It rebuilds the request from
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
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock};
use std::task::Context;

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use indexmap::IndexMap;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use serde_json::json;

use crate::ai::{
    GenerateTextOptions, Instructions, LanguageModel, ModelMessage, SystemModelMessage, ToolChoice,
    ToolSet, UserContent, UserModelMessage,
};
use crate::constants::{
    COMPACTION_FALLBACK_WINDOW_TOKENS, COMPACTION_TAIL_TOKENS, IDLE_COMPACTION_CACHE_SHARE,
    IDLE_COMPACTION_MIN_TOKENS, MAX_OUTPUT_TOKENS,
};
use crate::db::models::{ConversationThreadChangeset, MessageTrigger, ThreadSource};
use crate::db::schema::conversation_messages::dsl as m;
use crate::db::schema::conversation_threads::dsl as t;
use crate::db::sql_types::DbDateTime;
use crate::lib::context_window::context_window_for;
use crate::lib::llm_errors::is_context_overflow_error;
use crate::lib::llm_providers::create_provider::create_provider;
use crate::lib::llm_providers::llm_provider::{
    CachePointFragment, CacheTtl, LlmProvider, NO_CACHE_POINT, ProviderOptionsFragment,
    cache_request_options, cache_ttl_for, cache_ttl_ms,
};
use crate::lib::log_redaction::err_json;
use crate::lib::model_call::{ModelCallMeta, apply_telemetry, call_model};
use crate::lib::model_catalog::MIN_PLAUSIBLE_CONTEXT;
use crate::lib::model_routing::{compaction_model, compaction_model_for};
use crate::lib::model_selection::{StoredModelSelection, resolve_model_selection};
use crate::lib::spend_context::carried;
use crate::lib::task_tool::{Invoker, Subagent};
use crate::lib::telemetry::{langfuse_telemetry, track_event};
use crate::lib::tool_collection::{CollectToolsInput, collect_tools, with_tools_cache_control};
use crate::lib::tool_output_limiter::{ToolOutputCaptureOptions, with_tool_output_capture};
use crate::lib::tool_search::plan::{
    PlanToolSearchInput, ToolSearchPrompt, ToolSearchTelemetry, plan_tool_search,
};
use crate::prompts::channel_prompt::get_channel_behavior_instructions;
use crate::prompts::compaction_prompt::COMPACTION_PROMPT;
use crate::prompts::context_builder::ConversationMessage as HistoryRow;
use crate::prompts::context_builder::{
    PromptMode, SUMMARY_MESSAGE_OPENING, build_conversation_history, build_system_prompt_parts,
};
use crate::prompts::task_tool_prompt::get_task_tool_instructions;
use crate::services::agent_workspace_service::AGENT_WORKSPACE_SERVICE;
use crate::services::context_service::{AgentContextOptions, CONTEXT_SERVICE};
use crate::services::context_usage_service::{
    CONTEXT_USAGE_SERVICE, ContextUsageSnapshot, EstimateInput,
};
use crate::services::conversation_service::{CONVERSATION_SERVICE, MessageStored};
use crate::services::generated_ui::generated_ui_schema::is_generated_ui;
use crate::services::llm_call_service::{LLM_CALL_SERVICE, LlmCallPurpose};
use crate::services::message_delivery_service::MESSAGE_DELIVERY_SERVICE;
use crate::services::thread_turn_service::THREAD_TURN_SERVICE;
use crate::services::tool_ledger_service::{
    DeclareInput, TOOL_LEDGER_SERVICE, summary_tool_options,
};
use crate::support::{iso, js, now_ms};
use crate::{log_error, log_info, log_warn};

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

impl CompactionEvent {
    fn new(
        user_id: &str,
        thread_id: &str,
        status: CompactionStatus,
        trigger: CompactionTrigger,
    ) -> Self {
        Self {
            user_id: user_id.to_string(),
            thread_id: thread_id.to_string(),
            status,
            trigger,
            tokens_before: None,
            tokens_after: None,
            messages_compacted: None,
            error: None,
            detail: None,
            idle: None,
        }
    }
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
    /// Characters of the rows stored after the summarized context was read.
    later_chars: i64,
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

/// What the stored thread says about a compaction: its source, its last measured
/// size and its workspace.
struct StoredThread {
    thread_source: ThreadSource,
    context_tokens: Option<i64>,
    workspace_root: Option<String>,
    compacted_at: Option<DateTime<Utc>>,
}

/// A stored row's text, tool calls and blocks, for `stored_chars`.
type StoredRowChars = (String, Option<serde_json::Value>, Option<serde_json::Value>);

/// The characters stored rows add to a request: text, tool calls and blocks.
fn stored_chars(rows: &[StoredRowChars]) -> i64 {
    rows.iter()
        .map(|(content, tool_calls, blocks)| {
            let json = |value: &Option<serde_json::Value>| {
                value
                    .as_ref()
                    .map_or(0, |value| js::len16(&js::stringify(value)))
            };
            (js::len16(content) + json(tool_calls) + json(blocks)) as i64
        })
        .sum()
}

/// A rough characters-per-token ratio for rows no provider has counted.
const STORED_CHARS_PER_TOKEN: i64 = 4;

/// A DATABASE thread's size as its last measurement plus the rows stored after it,
/// at `STORED_CHARS_PER_TOKEN`, when that reaches the threshold: `Some` with the
/// time of that measurement (`None` inside when no turn or compaction has measured
/// it). `None` otherwise. The measurement is the newer of the thread's last turn and
/// its last compaction. A thread no turn has measured is sized from all its
/// uncompacted rows, against the window of the model its compaction would run on.
async fn stored_growth(
    agent_id: &str,
    thread_id: &str,
) -> anyhow::Result<Option<Option<DateTime<Utc>>>> {
    let Some(threshold) = crate::config::CONFIG.compaction_threshold_percent else {
        return Ok(None);
    };
    let id = thread_id.to_string();
    let thread = crate::db::run(move |conn| {
        Ok(t::conversation_threads
            .filter(t::id.eq(id))
            .select((
                t::thread_source,
                t::context_tokens,
                t::context_model,
                t::compacted_at,
            ))
            .first::<(
                ThreadSource,
                Option<i64>,
                Option<String>,
                Option<DateTime<Utc>>,
            )>(conn)
            .optional()?)
    })
    .await?;
    let Some((thread_source, context_tokens, context_model, compacted_at)) = thread else {
        return Ok(None);
    };
    if thread_source != ThreadSource::Database {
        return Ok(None);
    }
    let last_turn = LLM_CALL_SERVICE
        .newest_thread_call(thread_id, &THREAD_TURN_PURPOSES)
        .await;
    let measured_at = [last_turn.map(|call| call.created_at), compacted_at]
        .into_iter()
        .flatten()
        .max();
    let model_id = match context_model {
        Some(model_id) => model_id,
        None => unmeasured_compaction_model(agent_id, thread_id).await?,
    };
    let window_tokens = context_window_for(&model_id)
        .map(|window| window.tokens)
        .unwrap_or(COMPACTION_FALLBACK_WINDOW_TOKENS);
    if window_tokens < MIN_PLAUSIBLE_CONTEXT {
        return Ok(None);
    }
    let id = thread_id.to_string();
    let rows = crate::db::run(move |conn| {
        let mut query = m::conversation_messages
            .filter(m::thread_id.eq(id))
            .filter(m::is_compacted.eq(false))
            .select((m::content, m::tool_calls, m::blocks))
            .into_boxed();
        if let Some(measured_at) = measured_at {
            query = query.filter(m::created_at.gt(DbDateTime(measured_at)));
        }
        Ok(query.load::<StoredRowChars>(conn)?)
    })
    .await?;
    let chars = stored_chars(&rows);
    let measured = if measured_at.is_some() {
        context_tokens.unwrap_or(0)
    } else {
        0
    };
    let used_tokens = measured + (chars + STORED_CHARS_PER_TOKEN - 1) / STORED_CHARS_PER_TOKEN;
    let due = 100.0 * used_tokens as f64 / window_tokens as f64 >= threshold as f64;
    Ok(due.then_some(measured_at))
}

/// The model a compaction of a thread no turn has measured would run on: the agent's
/// model in Fixed mode, the largest tier in Auto mode.
async fn unmeasured_compaction_model(agent_id: &str, thread_id: &str) -> anyhow::Result<String> {
    let agent = AGENT_WORKSPACE_SERVICE.get_agent().await?;
    if agent.id != agent_id {
        anyhow::bail!("agent {agent_id} not found");
    }
    compaction_model_for(
        agent.model.as_deref(),
        &resolve_model_selection(&StoredModelSelection::from(&agent)),
        thread_id,
        &create_provider(),
    )
    .await
}

/// The thread's row, or `None` when it is gone.
async fn read_thread(thread_id: &str) -> anyhow::Result<Option<StoredThread>> {
    let id = thread_id.to_string();
    let row = crate::db::run(move |conn| {
        Ok(t::conversation_threads
            .filter(t::id.eq(id))
            .select((
                t::thread_source,
                t::context_tokens,
                t::workspace_root,
                t::compacted_at,
            ))
            .first::<(
                ThreadSource,
                Option<i64>,
                Option<String>,
                Option<DateTime<Utc>>,
            )>(conn)
            .optional()?)
    })
    .await?;
    Ok(row.map(
        |(thread_source, context_tokens, workspace_root, compacted_at)| StoredThread {
            thread_source,
            context_tokens,
            workspace_root,
            compacted_at,
        },
    ))
}

/// `{ userId, sessionId }`, the identifiers a compaction's trace has.
fn compaction_telemetry(params: &mut GenerateTextOptions, user_id: &str, thread_id: &str) {
    let mut identifiers = IndexMap::new();
    identifiers.insert("userId".to_string(), user_id.to_string());
    identifiers.insert("sessionId".to_string(), thread_id.to_string());
    apply_telemetry(
        params,
        langfuse_telemetry("compaction", Some(identifiers), None),
    );
}

/// The compaction prompt as the last user message, with the cache breakpoint.
fn compaction_prompt_message(cache_point: &CachePointFragment) -> ModelMessage {
    ModelMessage::User(UserModelMessage {
        content: UserContent::Text(COMPACTION_PROMPT.to_string()),
        provider_options: Some(cache_point.to_provider_options()),
    })
}

/// The tools of a forked summarize request: the declared list under 'auto' with
/// every call refused, or the turn's tools under 'none'.
fn apply_fork_tools(params: &mut GenerateTextOptions, fork: &CompactionFork) {
    if fork.declared_tools {
        apply_summary_tools(params, &fork.tools);
    } else {
        params.tools = (!fork.tools.is_empty()).then(|| fork.tools.clone());
        // Forbids tool use in the summary call. Where the SDK still sends the tools
        // block under 'none', it keeps the turn's tools segment.
        params.tool_choice = Some(ToolChoice::None);
    }
}

/// `...summaryToolOptions(tools)`.
fn apply_summary_tools(params: &mut GenerateTextOptions, tools: &ToolSet) {
    let options = summary_tool_options(tools);
    params.tools = Some(options.tools);
    params.tool_choice = Some(options.tool_choice);
    params.allow_system_in_messages = options.allow_system_in_messages;
    params.stop_when = Some(vec![options.stop_when]);
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
    /// The newest stored row of each thread that a stored run wrote while a compaction
    /// of it was queued or running. `settle` sizes that thread again.
    stored_during_compaction: Mutex<HashMap<String, MessageStored>>,
}

impl CompactionService {
    pub fn new() -> Self {
        Self {
            events: CompactionEvents::default(),
            in_flight: Mutex::new(HashSet::new()),
            idle_timers: Mutex::new(HashMap::new()),
            stored_during_compaction: Mutex::new(HashMap::new()),
        }
    }

    /// Whether any compaction is currently running.
    pub fn has_in_flight(&self) -> bool {
        !self.in_flight.lock().is_empty()
    }

    /// Ends a thread's queued or running compaction, and emits `settled`.
    fn settle(&'static self, thread_id: &str) {
        let stored = {
            // Under the `in_flight` lock, which `defer_while_compacting` holds while it
            // records a row, so a row recorded for this compaction is never left behind.
            let mut in_flight = self.in_flight.lock();
            in_flight.remove(thread_id);
            self.stored_during_compaction.lock().remove(thread_id)
        };
        self.events.emit_settled(thread_id);
        if let Some(stored) = stored {
            self.after_message_stored(stored);
        }
    }

    /// Stored-run path. A run without a turn in the conversation, such as a scheduled
    /// task, a heartbeat or a webhook, stores rows there that no turn has measured, so
    /// `maybe_auto_compact` never sees them. After such a row is stored, the
    /// conversation is sized as its last measurement plus an estimate of the rows
    /// stored since, and one at or over the threshold is compacted before the next turn
    /// reads it. A chat turn's own rows are measured at its end. Synchronous, never
    /// fails.
    pub fn after_message_stored(&'static self, stored: MessageStored) {
        if stored.triggered_by == MessageTrigger::UserInput {
            return;
        }
        if crate::config::CONFIG.compaction_threshold_percent.is_none() {
            return; // disabled by operator
        }
        if self.defer_while_compacting(&stored) {
            return;
        }
        tokio::spawn(carried(async move {
            let thread_id = stored.thread_id.clone();
            match stored_growth(&stored.agent_id, &thread_id).await {
                Ok(Some(_)) => {}
                Ok(None) => return,
                Err(err) => {
                    log_warn!(
                        json!({ "err": err_json(&err), "threadId": thread_id }),
                        "[Compaction] could not size a conversation after a stored run"
                    );
                    return;
                }
            }
            if !self.begin_unless_compacting(&stored) {
                return;
            }
            let input = IdleInput {
                user_id: stored.user_id.clone(),
                agent_id: stored.agent_id.clone(),
                thread_id: thread_id.clone(),
            };
            let result = THREAD_TURN_SERVICE
                .run(&thread_id, async {
                    // A turn or compaction that held the thread first has measured or
                    // compacted it.
                    let Some(measured_at) = stored_growth(&input.agent_id, &thread_id).await?
                    else {
                        return Ok(());
                    };
                    self.cancel_idle(&thread_id);
                    // A conversation no turn has measured has no warm cache to read.
                    let last_call_at = measured_at.unwrap_or(DateTime::<Utc>::UNIX_EPOCH);
                    self.compact_rebuilt(
                        &input,
                        CompactionTrigger::Auto,
                        CompactionReason::Threshold,
                        Some(last_call_at),
                    )
                    .await
                })
                .await;
            if let Err(err) = result {
                log_error!(
                    json!({ "err": err_json(&err), "threadId": thread_id }),
                    "[Compaction] stored-run compaction failed"
                );
                self.fail(
                    &input.user_id,
                    &input.agent_id,
                    &thread_id,
                    CompactionTrigger::Auto,
                    &error_text(&err),
                );
            }
            self.settle(&thread_id);
        }));
    }

    /// Keeps a row stored while the thread's compaction is queued or running for
    /// `settle`, which sizes the thread again once that compaction has committed.
    fn defer_while_compacting(&self, stored: &MessageStored) -> bool {
        let in_flight = self.in_flight.lock();
        if !in_flight.contains(&stored.thread_id) {
            return false;
        }
        self.stored_during_compaction
            .lock()
            .insert(stored.thread_id.clone(), stored.clone());
        true
    }

    /// `begin`, or, when the thread already has a compaction queued or running, keeps
    /// the row for `settle` as `defer_while_compacting` does and answers false.
    fn begin_unless_compacting(&self, stored: &MessageStored) -> bool {
        let mut in_flight = self.in_flight.lock();
        if in_flight.insert(stored.thread_id.clone()) {
            return true;
        }
        self.stored_during_compaction
            .lock()
            .insert(stored.thread_id.clone(), stored.clone());
        false
    }

    /// Marks `thread_id` as having a compaction queued or running; false when it
    /// already has one.
    fn begin(&self, thread_id: &str) -> bool {
        self.in_flight.lock().insert(thread_id.to_string())
    }

    /// Auto path. Synchronous and never fails — `invoke_stream` calls it on the hot
    /// path right before closing the step stream. All trigger policy lives here so
    /// the caller stays dumb: it hands over the fork unconditionally. The job is
    /// queued on the thread's mutex without waiting for it, so calling from inside
    /// the current turn cannot self-deadlock: the compaction runs after the claim
    /// releases.
    pub fn maybe_auto_compact(&'static self, fork: AutoCompactFork) {
        let Some(threshold) = crate::config::CONFIG.compaction_threshold_percent else {
            return; // disabled by operator
        };
        if fork.snapshot.used_percent < threshold {
            return;
        }
        // A window smaller than the plausibility floor is a poisoned or broken
        // catalog value; refusing to act on it bounds the blast radius of a bad
        // registry entry to a wrong percentage on screen (see model_catalog.rs).
        if fork.snapshot.window_tokens < MIN_PLAUSIBLE_CONTEXT {
            return;
        }
        if split_tail(&fork.fork.context_rows).compactable.is_empty() {
            return; // nothing meaningful
        }
        if !self.begin(&fork.fork.thread_id) {
            return; // once per exchange
        }

        let thread_id = fork.fork.thread_id.clone();
        self.queue_on_thread(thread_id, self.run_auto_compaction(fork));
    }

    /// Queues `work` on the thread's lock before returning, as a turn would, so no
    /// turn that asks for the lock later runs before it, and settles the thread
    /// when it ends. The work itself starts on a task of its own, after this call
    /// returns.
    fn queue_on_thread(
        &'static self,
        thread_id: String,
        work: impl Future<Output = ()> + Send + 'static,
    ) {
        let mut job: Pin<Box<dyn Future<Output = ()> + Send>> = Box::pin(async move {
            THREAD_TURN_SERVICE
                .run(&thread_id, async move {
                    // The first poll below only takes the place on the lock.
                    tokio::task::yield_now().await;
                    work.await;
                })
                .await;
            self.settle(&thread_id);
        });
        // A pending lock request joins the lock's FIFO queue on its first poll; the
        // spawned task polls it again with its own waker.
        let waker = futures::task::noop_waker();
        let mut cx = Context::from_waker(&waker);
        if job.as_mut().poll(&mut cx).is_pending() {
            tokio::spawn(carried(job));
        }
    }

    /// Idle path. After a chat turn under `CHAT_CACHE_TTL=1h`, a conversation of at
    /// least `IDLE_COMPACTION_MIN_TOKENS` is compacted once it has sat idle for most of
    /// its cache's lifetime, so the summary reads the turn's warm prefix. Any later
    /// invocation of the thread cancels the timer. The due time comes from stored data
    /// (`restore_idle`), so a restart re-arms it. Synchronous, never fails.
    pub fn arm_idle(&'static self, input: ArmIdleInput<'_>) {
        self.cancel_idle(&input.thread.thread_id);
        if !idle_compaction_armed() || input.used_tokens < IDLE_COMPACTION_MIN_TOKENS {
            return;
        }
        let Some(delay_ms) = idle_delay_ms(input.provider, &input.model_id) else {
            return;
        };
        // Measured from the turn's end; the cache clock started at its last request, at
        // most a few minutes earlier, which the delay leaves room for.
        self.schedule_idle(
            IdleDue {
                thread: input.thread,
                after: Utc::now(),
            },
            delay_ms,
        );
    }

    /// At boot, re-arm the idle compactions a restart dropped: the conversations used
    /// in the last day whose newest turn was a chat turn, of at least
    /// `IDLE_COMPACTION_MIN_TOKENS`, and not compacted since. One already past its due
    /// time is compacted at once.
    pub async fn restore_idle(&'static self) -> anyhow::Result<()> {
        if !idle_compaction_armed() {
            return Ok(());
        }
        let provider = create_provider();
        let since = DateTime::<Utc>::from_timestamp_millis(now_ms() - IDLE_RESTORE_WINDOW_MS)
            .unwrap_or_else(Utc::now);
        let candidates = CONVERSATION_SERVICE
            .list_idle_compaction_candidates(IDLE_COMPACTION_MIN_TOKENS, since)
            .await?;
        for thread in &candidates {
            let Some(last) = LLM_CALL_SERVICE
                .newest_thread_call(&thread.id, &THREAD_TURN_PURPOSES)
                .await
            else {
                continue;
            };
            if last.purpose != "chat" {
                continue;
            }
            if thread
                .compacted_at
                .is_some_and(|compacted_at| compacted_at >= last.created_at)
            {
                continue;
            }
            let Some(delay_ms) = idle_delay_ms(&provider, &last.model) else {
                continue;
            };
            let due_at = last.created_at.timestamp_millis() + delay_ms;
            self.schedule_idle(
                IdleDue {
                    thread: IdleInput {
                        user_id: thread.user_id.clone(),
                        agent_id: thread.agent_id.clone(),
                        thread_id: thread.id.clone(),
                    },
                    after: last.created_at,
                },
                (due_at - now_ms()).max(0),
            );
        }
        if !candidates.is_empty() {
            log_info!(
                "[Compaction] checked {} conversation(s) for idle compaction",
                candidates.len()
            );
        }
        Ok(())
    }

    /// Drops a conversation's idle timer: it has moved on, or is being compacted now.
    pub fn cancel_idle(&self, thread_id: &str) {
        if let Some(timer) = self.idle_timers.lock().remove(thread_id) {
            timer.abort();
        }
    }

    fn schedule_idle(&'static self, due: IdleDue, delay_ms: i64) {
        // The timer is recorded under the lock it takes when it fires, so a timer due
        // at once cannot fire before it is recorded.
        let mut timers = self.idle_timers.lock();
        if let Some(previous) = timers.remove(&due.thread.thread_id) {
            previous.abort();
        }
        let thread_id = due.thread.thread_id.clone();
        let delay = std::time::Duration::from_millis(delay_ms.max(0) as u64);
        let timer = tokio::spawn(carried(async move {
            tokio::time::sleep(delay).await;
            self.compact_idle(due);
        }));
        timers.insert(thread_id, timer.abort_handle());
    }

    /// The idle timer fired: compact the conversation unless a turn or a
    /// compaction since then did the job.
    fn compact_idle(&'static self, due: IdleDue) {
        self.idle_timers.lock().remove(&due.thread.thread_id);
        if !self.begin(&due.thread.thread_id) {
            return;
        }
        tokio::spawn(carried(async move {
            let thread_id = due.thread.thread_id.clone();
            let result = THREAD_TURN_SERVICE
                .run(&thread_id, async {
                    // A turn that claimed the thread before the timer fired ran first, so
                    // the conversation is no longer idle and this job stops. The
                    // tolerance covers a call row stamped just after the turn armed the
                    // timer; the next turn starts with a person's message, seconds later
                    // at least.
                    let last = LLM_CALL_SERVICE
                        .newest_thread_call(&thread_id, &THREAD_TURN_PURPOSES)
                        .await;
                    if let Some(last) = &last
                        && last.created_at.timestamp_millis()
                            > due.after.timestamp_millis() + STALE_TOLERANCE_MS
                    {
                        return Ok(());
                    }
                    // A compaction committed since then, by the threshold or a person,
                    // did the job.
                    let thread = read_thread(&thread_id).await?;
                    if thread
                        .and_then(|thread| thread.compacted_at)
                        .is_some_and(|compacted_at| compacted_at > due.after)
                    {
                        return Ok(());
                    }
                    let last_call_at = last.map(|last| last.created_at).unwrap_or(due.after);
                    self.compact_rebuilt(
                        &due.thread,
                        CompactionTrigger::Auto,
                        CompactionReason::Idle,
                        Some(last_call_at),
                    )
                    .await
                })
                .await;
            if let Err(err) = result {
                log_error!(
                    json!({ "err": err_json(&err), "threadId": thread_id }),
                    "[Compaction] idle compaction failed"
                );
                self.fail(
                    &due.thread.user_id,
                    &due.thread.agent_id,
                    &thread_id,
                    CompactionTrigger::Auto,
                    &error_text(&err),
                );
            }
            self.settle(&thread_id);
        }));
    }

    /// Overflow recovery. Called by `invoke_stream`'s error path when a turn's
    /// request outgrew the model's context window: that turn never reaches the
    /// threshold hook (it only runs on success), and every later turn rebuilds
    /// the same oversized context — without this, the thread is stuck rejecting
    /// forever. No threshold or window guard on purpose: the provider's own
    /// rejection is stronger evidence than any measured percentage, and it also
    /// covers models whose window we don't know. Synchronous, never fails.
    pub fn maybe_compact_after_overflow(&'static self, fork: CompactionFork) {
        if crate::config::CONFIG.compaction_threshold_percent.is_none() {
            return; // operator disabled auto-compaction
        }
        if split_tail(&fork.context_rows).compactable.is_empty() {
            return;
        }
        if !self.begin(&fork.thread_id) {
            return;
        }

        let thread_id = fork.thread_id.clone();
        self.queue_on_thread(thread_id, self.run_overflow_compaction(fork));
    }

    /// Manual path (`/compact` → REST): a compaction rebuilt from the stored thread
    /// under the thread mutex (see `compact_rebuilt`). A failure is reported as a
    /// `failed` event, never returned.
    pub async fn compact_now(&'static self, input: IdleInput) {
        // A queued idle compaction does what was asked, so it is left to run.
        if self.in_flight.lock().contains(&input.thread_id) {
            return; // one already queued/running is enough
        }
        self.cancel_idle(&input.thread_id);
        self.begin(&input.thread_id);
        let result = THREAD_TURN_SERVICE
            .run(
                &input.thread_id,
                self.compact_rebuilt(
                    &input,
                    CompactionTrigger::Manual,
                    CompactionReason::Manual,
                    None,
                ),
            )
            .await;
        if let Err(err) = result {
            log_error!(
                json!({ "err": err_json(&err), "threadId": input.thread_id }),
                "[Compaction] manual compaction failed"
            );
            self.fail(
                &input.user_id,
                &input.agent_id,
                &input.thread_id,
                CompactionTrigger::Manual,
                &error_text(&err),
            );
        }
        self.settle(&input.thread_id);
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
        let IdleInput {
            user_id,
            agent_id,
            thread_id,
        } = input;
        self.start(user_id, agent_id, thread_id, trigger);

        let thread = read_thread(thread_id).await?;
        let workspace_root = thread
            .as_ref()
            .and_then(|thread| thread.workspace_root.clone());
        let context = CONTEXT_SERVICE
            .get_agent_context(
                user_id,
                AgentContextOptions {
                    agent_id: agent_id.clone(),
                    thread_id: Some(thread_id.clone()),
                    include_conversation: Some(true),
                    verbose: None,
                },
            )
            .await?;
        let rows = to_fork_rows(&context.recent_messages);
        if split_tail(&rows).compactable.is_empty() {
            // A no-op, not a failure: the REST precheck cannot size the tail, so a
            // short thread lands here.
            self.skip(
                user_id,
                agent_id,
                thread_id,
                trigger,
                "Nothing to compact yet.",
            );
            return Ok(());
        }

        let provider = create_provider();
        let model_id = compaction_model(&context, thread_id, &provider).await?;
        let model = provider.model(&model_id)?;
        // The chat turns' lifetime, since on some vendors an entry of another lifetime
        // replaces the thread's entry instead of reading it. An idle summary whose cache
        // has expired reads the thread at full price whatever it asks for, and nothing
        // reuses its prefix, so it writes no entry at all.
        let ttl = cache_ttl_for("chat");
        let cold = last_call_at.is_some_and(|at| {
            now_ms() - at.timestamp_millis() > cache_ttl_ms(&provider, &model_id, ttl)
        });
        let cache_point = if cold {
            NO_CACHE_POINT
        } else {
            provider.cache_point(&model_id, Some(ttl))
        };
        let cache_request = cache_request_options(&provider, &model_id, ttl, !cold);

        // A conversation with a declared tool list sends that list: its cached
        // prefix starts with it, and its tool-change announcements name it.
        let protocol = provider.tool_changes(&model_id);
        let known =
            protocol.and_then(|protocol| TOOL_LEDGER_SERVICE.peek(thread_id, &model_id, protocol));

        // Same tool set as a chat turn: the tools block must match byte-for-byte
        // or the request misses the tools+stable-system cache prefix chat turns
        // keep warm. The Task invoker can never run here. A declared list is the
        // tools block itself, but deferred tools still need the collected set for
        // the catalog and the replayed loads.
        let deferred_tool_protocol = provider.deferred_tools(&model_id);
        let collected = if known.is_some() && deferred_tool_protocol.is_none() {
            None
        } else {
            Some(
                collect_tools(CollectToolsInput {
                    computer_use: None,
                    user_id: user_id.clone(),
                    agent_id: agent_id.clone(),
                    thread_id: Some(thread_id.clone()),
                    mode: "chat".to_string(),
                    origin_channel: None,
                    origin_channel_id: None,
                    posting_ceiling: None,
                    heartbeat_triggered: false,
                    workspace_root: workspace_root.clone(),
                    task_invoker: never_invoke(),
                    register_attachment_injection: None,
                    pending_file_writes: None,
                    locked_in: context.locked_in,
                })
                .await?,
            )
        };
        let subagents: Vec<Subagent> = match &collected {
            Some(collected) => collected
                .subagents
                .iter()
                .map(|s| Subagent {
                    name: s.name.clone(),
                    description: s.description.clone(),
                })
                .collect(),
            None => AGENT_WORKSPACE_SERVICE
                .get_subagents(agent_id)
                .await?
                .into_iter()
                .map(|s| Subagent {
                    name: s.agent.name,
                    description: s.description,
                })
                .collect(),
        };
        // Nothing executes here, so saving is off — the wrap exists only so this
        // request's tools block is built exactly like a chat turn's, which is what the
        // provider's cache prefix is keyed on.
        let (search_tools, deferrable) = match collected {
            Some(collected) => (
                with_tool_output_capture(
                    collected.tools,
                    ToolOutputCaptureOptions {
                        spill: Some(false),
                        ..Default::default()
                    },
                ),
                collected.deferrable,
            ),
            None => (ToolSet::new(), Vec::new()),
        };
        let tool_search = plan_tool_search(PlanToolSearchInput {
            tools: search_tools,
            deferrable,
            protocol: deferred_tool_protocol,
            model_id: model_id.clone(),
            telemetry: ToolSearchTelemetry {
                user_id: user_id.clone(),
                agent_id: agent_id.clone(),
                mode: "compaction".to_string(),
            },
        })
        .await;
        // A conversation the ledger has no record of, as after a restart, gets the
        // list its next chat turn would declare. Without a declared list the
        // request goes out under tool choice 'none', which sends no tools block and
        // so misses the prefix the chat turns cached.
        let declared = match (protocol, known) {
            (Some(_), Some(known)) => Some(known),
            (Some(protocol), None) => {
                let row_ids: Vec<String> = context
                    .recent_messages
                    .iter()
                    .map(|row| row.id.clone())
                    .collect();
                Some(
                    TOOL_LEDGER_SERVICE
                        .declare(DeclareInput {
                            thread_id,
                            model_id: &model_id,
                            protocol,
                            available: &tool_search.tools,
                            row_ids: &row_ids,
                        })
                        .await,
                )
            }
            (None, _) => None,
        };
        // A declared list is already the tools block the chat turns send.
        let declared_deferred: HashSet<String> = declared
            .as_ref()
            .map(|declared| declared.deferred.iter().cloned().collect())
            .unwrap_or_default();
        let cached_tools = with_tools_cache_control(
            declared
                .as_ref()
                .map(|declared| declared.tools.clone())
                .unwrap_or_else(|| tool_search.tools.clone()),
            cache_point,
            &declared_deferred,
        );

        let mut system_parts =
            build_system_prompt_parts(&context, PromptMode::Chat, None, workspace_root.as_deref())
                .await?;
        // Mirror invoke.rs: task-tool instructions, and a shared web chat's
        // channel instructions, ride the stable part, and cacheable parts carry
        // the Anthropic breakpoints — without them this request neither reads nor
        // refreshes the shared prefix. The thread records no origin channel, so
        // its label comes as for a continuation.
        let channel_label = MESSAGE_DELIVERY_SERVICE
            .thread_context(thread_id, None, None)
            .await?
            .channel_label
            .filter(|label| !label.is_empty());
        let tool_search_prompt = match &declared {
            Some(declared) => {
                (tool_search.prompt_for)(
                    declared.tools.clone(),
                    declared.deferred.iter().cloned().collect(),
                )
                .await
            }
            None => ToolSearchPrompt {
                catalog: tool_search.catalog.clone(),
                replay_tool_call: tool_search.replay_tool_call.clone(),
            },
        };
        if let Some(stable_part) = system_parts.iter_mut().find(|part| part.cacheable) {
            if let Some(label) = &channel_label {
                stable_part.text += "\n\n";
                stable_part.text += &get_channel_behavior_instructions(label);
            }
            if !subagents.is_empty() {
                stable_part.text += "\n\n";
                stable_part.text += &get_task_tool_instructions(&subagents);
            }
            if let Some(catalog) = tool_search_prompt
                .catalog
                .as_ref()
                .filter(|catalog| !catalog.is_empty())
            {
                stable_part.text += "\n\n";
                stable_part.text += catalog;
            }
        }
        let system: Vec<SystemModelMessage> = system_parts
            .into_iter()
            .map(|part| SystemModelMessage {
                content: part.text,
                provider_options: part.cacheable.then(|| cache_point.to_provider_options()),
            })
            .collect();
        let history = build_conversation_history(
            &context,
            declared
                .as_ref()
                .map(|declared| declared.tool_changes.as_slice())
                .unwrap_or(&[]),
            Some(&tool_search_prompt),
            channel_label.is_some(),
        );
        let mut messages = history.messages;
        messages.push(compaction_prompt_message(&cache_point));
        messages.extend(history.trailing_tool_changes);

        let mut params = GenerateTextOptions::new(model);
        params.system = Some(Instructions::Messages(system));
        params.messages = Some(messages);
        if declared.is_some() || tool_search.summary_declares_tools {
            apply_summary_tools(&mut params, &cached_tools);
        } else if !cached_tools.is_empty() {
            params.tools = Some(cached_tools);
            params.tool_choice = Some(ToolChoice::None);
        }
        params.max_output_tokens = Some(summary_output_budget(
            context_window_for(&model_id).map(|window| window.tokens),
            thread.as_ref().and_then(|thread| thread.context_tokens),
        ));
        params.provider_options = Some(cache_request);
        compaction_telemetry(&mut params, user_id, thread_id);
        let result = call_model(
            ModelCallMeta {
                purpose: LlmCallPurpose::Compaction,
                thread_id: Some(thread_id.clone()),
                agent_id: None,
                request_id: None,
                source: None,
            },
            params,
        )
        .await?;
        let summary = match read_summary(&result.text(), result.finish_reason().as_str()) {
            Ok(summary) => summary,
            Err(error) => {
                self.fail(user_id, agent_id, thread_id, trigger, &error);
                return Ok(());
            }
        };

        self.complete(CompleteInput {
            user_id: user_id.clone(),
            agent_id: agent_id.clone(),
            thread_id: thread_id.clone(),
            trigger,
            reason,
            model_id,
            thread_source: thread
                .as_ref()
                .map(|thread| thread.thread_source)
                .unwrap_or(ThreadSource::Database)
                .as_str()
                .to_string(),
            tokens_before: thread.as_ref().and_then(|thread| thread.context_tokens),
            summary,
            rows,
        })
        .await
    }

    /// Cheap REST precheck. Counts DB rows, which is right for DATABASE threads;
    /// live-read threads pass through (their history lives in the channel, and
    /// `compact_now`'s own row check covers them).
    pub async fn has_compactable_history(&self, thread_id: &str) -> anyhow::Result<bool> {
        let thread = read_thread(thread_id).await?;
        // Channel-backed threads pass through — their history lives in the
        // channel, not in DB rows, so a row count says nothing about them.
        if thread.map(|thread| thread.thread_source) != Some(ThreadSource::Database) {
            return Ok(true);
        }
        // A row count cannot size the tail, which is measured in tokens, so this asks only
        // for some history. compact_now's own check decides the rest.
        let id = thread_id.to_string();
        let uncompacted: i64 = crate::db::run(move |conn| {
            Ok(m::conversation_messages
                .filter(m::thread_id.eq(id))
                .filter(m::is_compacted.eq(false))
                .count()
                .get_result(conn)?)
        })
        .await?;
        Ok(uncompacted > 0)
    }

    /// The forked summarize request — see the module doc for the cache story.
    async fn run_auto_compaction(&self, fork: AutoCompactFork) {
        let AutoCompactFork {
            fork,
            final_assistant_text,
            snapshot,
        } = fork;
        let (user_id, agent_id, thread_id) = (
            fork.user_id.clone(),
            fork.agent_id.clone(),
            fork.thread_id.clone(),
        );
        let result: anyhow::Result<()> = async {
            self.start(&user_id, &agent_id, &thread_id, CompactionTrigger::Auto);

            let assistant_text = js::trim(&final_assistant_text);
            // The cache breakpoint on the final message is what makes this a cheap
            // forked request: Anthropic/Bedrock only cache-read at explicit
            // breakpoints, and the longest-prefix lookup reaches back past the few
            // appended blocks to the cache entry the turn's own last step wrote
            // (prepare_step marks its last message). Without it the tools+system
            // prefix would hit but the history — the bulk of the prompt — would be
            // re-prefilled at full price. Budget: 1 system + 1 tools + this = 3, inside
            // Bedrock's limit of 4.
            let mut messages: Vec<ModelMessage> = fork.messages.clone();
            messages.extend(fork.injections.iter().cloned());
            // An empty assistant block would be rejected by the provider; a turn
            // can end with no visible text (rare), in which case the last real
            // message already closes the exchange.
            if !assistant_text.is_empty() {
                messages.push(ModelMessage::assistant(assistant_text));
            }
            messages.push(compaction_prompt_message(&fork.cache_point));

            let mut params = GenerateTextOptions::new(Arc::clone(&fork.model));
            params.system = Some(Instructions::Messages(fork.system.clone()));
            params.messages = Some(messages);
            apply_fork_tools(&mut params, &fork);
            params.max_output_tokens = Some(summary_output_budget(
                Some(snapshot.window_tokens),
                Some(snapshot.used_tokens),
            ));
            params.provider_options = Some(fork.cache_request.clone());
            compaction_telemetry(&mut params, &user_id, &thread_id);
            let result = call_model(
                ModelCallMeta {
                    purpose: LlmCallPurpose::Compaction,
                    thread_id: Some(thread_id.clone()),
                    agent_id: None,
                    request_id: None,
                    source: None,
                },
                params,
            )
            .await?;
            let summary = match read_summary(&result.text(), result.finish_reason().as_str()) {
                Ok(summary) => summary,
                Err(error) => {
                    self.fail(
                        &user_id,
                        &agent_id,
                        &thread_id,
                        CompactionTrigger::Auto,
                        &error,
                    );
                    return Ok(());
                }
            };

            let thread = read_thread(&thread_id).await?;
            self.complete(CompleteInput {
                user_id: user_id.clone(),
                agent_id: agent_id.clone(),
                thread_id: thread_id.clone(),
                trigger: CompactionTrigger::Auto,
                reason: CompactionReason::Threshold,
                model_id: fork.model_id.clone(),
                thread_source: thread
                    .map(|thread| thread.thread_source)
                    .unwrap_or(ThreadSource::Database)
                    .as_str()
                    .to_string(),
                tokens_before: Some(snapshot.used_tokens),
                summary,
                rows: fork.context_rows.clone(),
            })
            .await
        }
        .await;
        if let Err(err) = result {
            log_error!(
                json!({ "err": err_json(&err), "threadId": thread_id }),
                "[Compaction] auto-compaction failed"
            );
            self.fail(
                &user_id,
                &agent_id,
                &thread_id,
                CompactionTrigger::Auto,
                &error_text(&err),
            );
        }
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
        let (user_id, agent_id, thread_id) = (
            fork.user_id.clone(),
            fork.agent_id.clone(),
            fork.thread_id.clone(),
        );
        let result: anyhow::Result<()> = async {
            self.start(&user_id, &agent_id, &thread_id, CompactionTrigger::Auto);

            let mut history: Vec<ModelMessage> = fork.messages.clone();
            history.extend(fork.injections.iter().cloned());
            // Each shrink drops a quarter, so the reachable floor is 0.75^(n-1) of
            // the original: 5 attempts bottom out at ~32%, which still overflows a
            // history several times the window — and that is exactly the first turn
            // on a thread whose full history was never compacted before. 10 attempts
            // reach ~7.5%, enough for a thread carrying ~10x the window. The cap is
            // only a runaway guard; shrink_history_head's `None` is the real
            // terminating condition.
            const MAX_ATTEMPTS: usize = 10;
            let mut attempt = 0;
            let summary = loop {
                let mut messages = history.clone();
                messages.push(compaction_prompt_message(&fork.cache_point));
                let mut params = GenerateTextOptions::new(Arc::clone(&fork.model));
                params.system = Some(Instructions::Messages(fork.system.clone()));
                params.messages = Some(messages);
                apply_fork_tools(&mut params, &fork);
                params.max_output_tokens = Some(MAX_OUTPUT_TOKENS);
                params.provider_options = Some(fork.cache_request.clone());
                compaction_telemetry(&mut params, &user_id, &thread_id);
                match call_model(
                    ModelCallMeta {
                        purpose: LlmCallPurpose::Compaction,
                        thread_id: Some(thread_id.clone()),
                        agent_id: None,
                        request_id: None,
                        source: None,
                    },
                    params,
                )
                .await
                {
                    Ok(result) => {
                        break read_summary(&result.text(), result.finish_reason().as_str());
                    }
                    Err(err) => {
                        if attempt >= MAX_ATTEMPTS - 1 || !is_context_overflow_error(&err) {
                            return Err(err);
                        }
                        let Some(shrunk) = shrink_history_head(&history) else {
                            return Err(err);
                        };
                        log_info!(
                            "[Compaction] summarize overflowed for thread {}; retrying with {}/{} messages",
                            thread_id,
                            shrunk.len(),
                            history.len()
                        );
                        history = shrunk;
                    }
                }
                attempt += 1;
            };
            let summary = match summary {
                Ok(summary) => summary,
                Err(error) => {
                    self.fail(
                        &user_id,
                        &agent_id,
                        &thread_id,
                        CompactionTrigger::Auto,
                        &error,
                    );
                    return Ok(());
                }
            };

            let thread = read_thread(&thread_id).await?;
            self.complete(CompleteInput {
                user_id: user_id.clone(),
                agent_id: agent_id.clone(),
                thread_id: thread_id.clone(),
                trigger: CompactionTrigger::Auto,
                reason: CompactionReason::Overflow,
                model_id: fork.model_id.clone(),
                thread_source: thread
                    .as_ref()
                    .map(|thread| thread.thread_source)
                    .unwrap_or(ThreadSource::Database)
                    .as_str()
                    .to_string(),
                tokens_before: thread.and_then(|thread| thread.context_tokens),
                summary,
                rows: fork.context_rows.clone(),
            })
            .await
        }
        .await;
        if let Err(err) = result {
            log_error!(
                json!({ "err": err_json(&err), "threadId": thread_id }),
                "[Compaction] overflow compaction failed"
            );
            self.fail(
                &user_id,
                &agent_id,
                &thread_id,
                CompactionTrigger::Auto,
                &error_text(&err),
            );
        }
    }

    /// Shared last step of every runner: commit the summary, report it.
    async fn complete(&self, input: CompleteInput) -> anyhow::Result<()> {
        let (messages_compacted, tail, later_chars) = self
            .commit(&input.thread_id, &input.summary, input.rows)
            .await?;
        self.finish(FinishInput {
            user_id: input.user_id,
            agent_id: input.agent_id,
            thread_id: input.thread_id,
            trigger: input.trigger,
            reason: input.reason,
            model_id: input.model_id,
            thread_source: input.thread_source,
            tokens_before: input.tokens_before,
            summary: input.summary,
            messages_compacted,
            tail,
            later_chars,
        })
        .await;
        Ok(())
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
    ) -> anyhow::Result<(i64, Vec<ForkRow>, i64)> {
        let TailSplit { compactable, tail } = split_tail(&rows);
        if compactable.is_empty() {
            return Ok((0, tail, 0));
        }
        let mut later_chars = 0;

        let thread = read_thread(thread_id).await?;
        let id = thread_id.to_string();
        let summary_text = summary.to_string();

        if thread.map(|thread| thread.thread_source) != Some(ThreadSource::Database) {
            let external_message_ids: Vec<String> = compactable
                .iter()
                .filter_map(|row| row.external_message_id.clone())
                .filter(|ts| !ts.is_empty())
                .collect();
            let watermark = external_message_ids.into_iter().reduce(|max, ts| {
                if js_parse_float(&ts) > js_parse_float(&max) {
                    ts
                } else {
                    max
                }
            });
            // The watermark covers the rows read from the channel. The rows read from
            // the database have no channel id: internal steps and button presses.
            let internal_ids: Vec<String> = compactable
                .iter()
                .filter(|row| row.internal_step || row.external_message_id.is_none())
                .map(|row| row.id.clone())
                .collect();
            crate::db::run(move |conn| {
                conn.transaction(|conn| {
                    diesel::update(m::conversation_messages.filter(m::id.eq_any(&internal_ids)))
                        .set(m::is_compacted.eq(true))
                        .execute(conn)?;
                    let now = Utc::now();
                    let changes = ConversationThreadChangeset {
                        compaction_summary: Some(Some(summary_text)),
                        compacted_at: Some(Some(now)),
                        compacted_through_ts: watermark.map(Some),
                        updated_at: Some(DbDateTime(now)),
                        ..ConversationThreadChangeset::default()
                    };
                    diesel::update(t::conversation_threads.filter(t::id.eq(&id)))
                        .set(&changes)
                        .execute(conn)?;
                    Ok::<_, anyhow::Error>(())
                })
            })
            .await?;
        } else {
            let ids: Vec<String> = compactable.iter().map(|row| row.id.clone()).collect();
            let read_ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
            let later_id = id.clone();
            let compacted_at = crate::db::run(move |conn| {
                let mut ids = ids;
                let newest: Option<DateTime<Utc>> = m::conversation_messages
                    .filter(m::id.eq_any(&ids))
                    .order(m::created_at.desc())
                    .select(m::created_at)
                    .first::<DateTime<Utc>>(conn)
                    .optional()?;
                // A generated UI is left out of the context, which replays it through
                // its `show_ui` call, so the UIs in the summarized range are compacted
                // with it.
                if let Some(newest) = newest {
                    let uis: Vec<(String, Option<serde_json::Value>)> = m::conversation_messages
                        .filter(m::thread_id.eq(&id))
                        .filter(m::is_compacted.eq(false))
                        .filter(m::created_at.le(DbDateTime(newest)))
                        .filter(m::blocks.is_not_null())
                        .select((m::id, m::blocks))
                        .load(conn)?;
                    ids.extend(
                        uis.into_iter()
                            .filter(|(_, blocks)| is_generated_ui(blocks.as_ref()))
                            .map(|(id, _)| id),
                    );
                }
                conn.transaction(|conn| {
                    diesel::update(m::conversation_messages.filter(m::id.eq_any(&ids)))
                        .set(m::is_compacted.eq(true))
                        .execute(conn)?;
                    let now = Utc::now();
                    let changes = ConversationThreadChangeset {
                        compaction_summary: Some(Some(summary_text)),
                        compacted_at: Some(Some(now)),
                        compacted_through_ts: Some(newest.map(|at| iso(&at))),
                        updated_at: Some(DbDateTime(now)),
                        ..ConversationThreadChangeset::default()
                    };
                    diesel::update(t::conversation_threads.filter(t::id.eq(&id)))
                        .set(&changes)
                        .execute(conn)?;
                    Ok::<_, anyhow::Error>(now)
                })
            })
            .await?;
            // A stored run can write rows after the summarized context was read. They
            // stay verbatim, and the size this compaction stores counts them, because
            // the stored-run sizing reads only the rows stored after `compactedAt`.
            let later = crate::db::run(move |conn| {
                Ok(m::conversation_messages
                    .filter(m::thread_id.eq(later_id))
                    .filter(m::is_compacted.eq(false))
                    .filter(m::created_at.le(DbDateTime(compacted_at)))
                    .filter(m::id.ne_all(read_ids))
                    .select((m::content, m::tool_calls, m::blocks))
                    .load::<StoredRowChars>(conn)?)
            })
            .await?;
            let later: Vec<StoredRowChars> = later
                .into_iter()
                .filter(|(_, _, blocks)| !is_generated_ui(blocks.as_ref()))
                .collect();
            later_chars = stored_chars(&later);
        }

        log_info!(
            "[Compaction] compacted {} message(s) in thread {} ({} chars of summary)",
            compactable.len(),
            thread_id,
            js::len16(summary)
        );
        Ok((compactable.len() as i64, tail, later_chars))
    }

    /// Shared completion: meter estimate, completed event, finished telemetry.
    async fn finish(&self, input: FinishInput) {
        let tail_chars: i64 = input.tail.iter().map(|row| row.content_chars).sum();
        // ~4 chars/token over the rebuilt context (summary message, verbatim tail and
        // the rows stored after the summarized context was read).
        // Undershoots — the system prompt and tools aren't counted — and
        // self-corrects on the next turn's provider-reported usage.
        let estimated_tokens =
            (js::len16(&input.summary) as i64 + tail_chars + input.later_chars + 3) / 4;

        let snapshot = CONTEXT_USAGE_SERVICE.apply_estimate(EstimateInput {
            user_id: input.user_id.clone(),
            thread_id: input.thread_id.clone(),
            model_id: input.model_id.clone(),
            used_tokens: estimated_tokens,
        });

        let mut event = CompactionEvent::new(
            &input.user_id,
            &input.thread_id,
            CompactionStatus::Completed,
            input.trigger,
        );
        event.tokens_before = Some(input.tokens_before);
        event.tokens_after = Some(snapshot.as_ref().map(|_| estimated_tokens));
        event.messages_compacted = Some(input.messages_compacted);
        if input.reason == CompactionReason::Idle {
            event.idle = Some(true);
        }
        self.events.emit_compaction(&event);

        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), input.agent_id.clone());
        props.insert("thread.id".to_string(), input.thread_id.clone());
        props.insert("thread.source".to_string(), input.thread_source.clone());
        props.insert(
            "compaction.trigger".to_string(),
            input.trigger.as_str().to_string(),
        );
        props.insert(
            "compaction.reason".to_string(),
            input.reason.as_str().to_string(),
        );
        props.insert(
            "compaction.messages_compacted".to_string(),
            input.messages_compacted.to_string(),
        );
        if let Some(tokens_before) = input.tokens_before {
            props.insert(
                "context.tokens_before".to_string(),
                tokens_before.to_string(),
            );
        }
        if let Some(snapshot) = &snapshot {
            props.insert(
                "context.tokens_after".to_string(),
                estimated_tokens.to_string(),
            );
            props.insert(
                "context.window_tokens".to_string(),
                snapshot.window_tokens.to_string(),
            );
        }
        track_event("compaction finished", Some(&input.user_id), Some(props));
    }

    fn start(&self, user_id: &str, agent_id: &str, thread_id: &str, trigger: CompactionTrigger) {
        self.events.emit_compaction(&CompactionEvent::new(
            user_id,
            thread_id,
            CompactionStatus::Started,
            trigger,
        ));
        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), agent_id.to_string());
        props.insert("thread.id".to_string(), thread_id.to_string());
        props.insert(
            "compaction.trigger".to_string(),
            trigger.as_str().to_string(),
        );
        track_event("compaction started", Some(user_id), Some(props));
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
        let mut event =
            CompactionEvent::new(user_id, thread_id, CompactionStatus::Skipped, trigger);
        event.detail = Some(detail.to_string());
        self.events.emit_compaction(&event);
        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), agent_id.to_string());
        props.insert("thread.id".to_string(), thread_id.to_string());
        props.insert(
            "compaction.trigger".to_string(),
            trigger.as_str().to_string(),
        );
        track_event("compaction skipped", Some(user_id), Some(props));
    }

    fn fail(
        &self,
        user_id: &str,
        agent_id: &str,
        thread_id: &str,
        trigger: CompactionTrigger,
        error: &str,
    ) {
        let mut event = CompactionEvent::new(user_id, thread_id, CompactionStatus::Failed, trigger);
        event.error = Some(error.to_string());
        self.events.emit_compaction(&event);
        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), agent_id.to_string());
        props.insert("thread.id".to_string(), thread_id.to_string());
        props.insert(
            "compaction.trigger".to_string(),
            trigger.as_str().to_string(),
        );
        props.insert("error.message".to_string(), error.to_string());
        track_event("compaction failed", Some(user_id), Some(props));
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
    messages
        .iter()
        .map(|message| ForkRow {
            id: message.id.clone(),
            external_message_id: message.external_message_id.clone(),
            internal_step: message.internal_step,
            from_user: message.role == crate::db::models::MessageRole::User
                && !message.internal_step,
            content_chars: js::len16(&message.content) as i64
                + message
                    .tool_calls
                    .as_ref()
                    .filter(|tool_calls| js::truthy(tool_calls))
                    .map(|tool_calls| js::len16(&crate::ai::json::js_stringify(tool_calls)) as i64)
                    .unwrap_or(0),
        })
        .collect()
}

/// The rows a compaction keeps verbatim, and the ones before them it summarizes.
/// The tail is the longest run of newest rows that starts on a user's message, holds
/// at most `compaction_tail_messages` rows and fits `COMPACTION_TAIL_TOKENS`. The row
/// cap gives way for the newest exchange, since one reply can be many step rows.
/// When even the newest exchange does not fit the token budget, everything is
/// summarized. A thread with no user message keeps its newest rows that fit both.
pub fn split_tail(rows: &[ForkRow]) -> TailSplit {
    split_tail_at(rows, crate::config::CONFIG.compaction_tail_messages)
}

/// `split_tail` with a tail of at most `tail_messages` rows.
fn split_tail_at(rows: &[ForkRow], tail_messages: i64) -> TailSplit {
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
    let text = js::trim(text);
    if text.is_empty() {
        Err("The model returned an empty summary.".to_string())
    } else {
        Ok(text.to_string())
    }
}

fn error_text(err: &anyhow::Error) -> String {
    err.to_string()
}

/// `parseFloat`: the longest leading decimal number, or NaN.
fn js_parse_float(text: &str) -> f64 {
    static FLOAT_PREFIX: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)")
            .expect("valid regex")
    });
    let trimmed = js::trim_start(text);
    match FLOAT_PREFIX.find(trimmed) {
        Some(found) => {
            let number = found.as_str();
            match number.trim_start_matches(['+', '-']) {
                "Infinity" if number.starts_with('-') => f64::NEG_INFINITY,
                "Infinity" => f64::INFINITY,
                _ => number.parse().unwrap_or(f64::NAN),
            }
        }
        None => f64::NAN,
    }
}

/// Task-tool invoker for compaction requests. They send tool choice 'none', so
/// the tool's execute can never run; this exists only so the tool's wire schema
/// matches a chat turn's.
fn never_invoke() -> Invoker {
    Arc::new(|_request| {
        Box::pin(async {
            Err(anyhow::anyhow!(
                "Subagent tasks cannot run during compaction"
            ))
        })
    })
}

/// Drop the oldest quarter of a summarize history that did not fit, then
/// re-anchor on a user message: an array sliced mid tool-exchange could start
/// on an assistant tool-call or a dangling tool result, both of which the
/// providers reject. A previous summary opens the history and stays, since it
/// stands for everything before it. Returns `None` when nothing meaningful would
/// remain.
fn shrink_history_head(history: &[ModelMessage]) -> Option<Vec<ModelMessage>> {
    let head_len = usize::from(is_summary_message(history.first()));
    let (head, rest) = history.split_at(head_len);
    let drop = rest.len().div_ceil(4).max(1).min(rest.len());
    let shrunk = anchor_on_user(&rest[drop..]);
    if !shrunk.is_empty() && shrunk.len() < rest.len() {
        let mut kept = head.to_vec();
        kept.extend(shrunk);
        return Some(kept);
    }
    // Nothing is left to drop behind the summary, so the summary goes last.
    let without_summary = anchor_on_user(rest);
    if !head.is_empty() && !without_summary.is_empty() {
        Some(without_summary)
    } else {
        None
    }
}

fn anchor_on_user(messages: &[ModelMessage]) -> Vec<ModelMessage> {
    match messages
        .iter()
        .position(|message| matches!(message, ModelMessage::User(_)))
    {
        Some(first) => messages[first..].to_vec(),
        None => Vec::new(),
    }
}

/// Whether `message` is the summary message that opens a compacted history.
fn is_summary_message(message: Option<&ModelMessage>) -> bool {
    matches!(
        message,
        Some(ModelMessage::User(UserModelMessage {
            content: UserContent::Text(text),
            ..
        })) if text.starts_with(SUMMARY_MESSAGE_OPENING)
    )
}

pub static COMPACTION_SERVICE: LazyLock<CompactionService> = LazyLock::new(CompactionService::new);

#[cfg(test)]
#[path = "compaction_service_tests.rs"]
mod tests;
