//! Heartbeat Service (Agent-Runtime)
//!
//! Manages the always-on heartbeat system for personal agents.
//! Invokes the LLM directly (in-process).
//!
//! Key design principles:
//! - The interval is measured from the last run, not from the timer's creation,
//!   so a restart or a re-registration cannot defer a check
//! - A run reaches people only through what the agent posts with `send_message`
//! - The send record tells a run what earlier runs already sent

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use anyhow::anyhow;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::models::{AgentHeartbeatStatus, AgentWorkspace, MessageRole, MessageTrigger};
use crate::db::schema::agent_workspaces::dsl as aw;
use crate::db::schema::conversation_messages::dsl as m;
use crate::db::schema::conversation_threads::dsl as t;
use crate::invoke::invoke;
use crate::lib::last_response_text::last_response_text;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::lib::workspace_docs::WorkspaceDocField;
use crate::prompts::context_builder::format_time_ago;
use crate::services::agent_status_service::{AGENT_STATUS_SERVICE, HeartbeatScheduleUpdate};
use crate::services::channel_adapter_interface::ChatPlatform;
use crate::services::delivery_target_service::{
    DELIVERY_TARGET_SERVICE, DeliveryTarget, TargetPublishOptions, TargetTrigger, parse_comma_list,
};
use crate::services::document_revision_service::DOCUMENT_REVISION_SERVICE;
use crate::services::heartbeat_schedule::{heartbeat_delay_ms, heartbeat_due_at};
use crate::services::outbound_message_service::{
    OUTBOUND_MESSAGE_SERVICE, SentMessageEntry, WITHHELD_RUN_TEXT, WithheldRun, sent_message_list,
};
use crate::services::pending_work_service::{
    MAX_RESUME_ATTEMPTS, PENDING_WORK_SERVICE, PendingWorkItem, PendingWorkKind,
};
use crate::support::{js, now_ms};
use crate::types::{
    ChannelTriggerMessage, HeartbeatTrigger, InvokeErrorType, InvokeMode, InvokeRequest,
    InvokeResponse, InvokeStep, TaskLastSend, TaskReport, ToolCallRecord, TriggerPlace,
};
use crate::{log_error, log_info, log_warn};

/// The stored text of a heartbeat run that stopped at the spending limit. It is
/// kept, not delivered, when the run sent a message before the limit.
const HEARTBEAT_BUDGET_NOTICE: &str =
    "This heartbeat check stopped: your organization's AI spending limit has been reached.";

/// How many stored heartbeat messages a restart reads to restore the send record.
const SEND_RECORD_ROWS: i64 = 20;

/// How a heartbeat run ended: it posted, posted nothing, or ended in an error the runtime delivered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeartbeatOutcome {
    Posted,
    Silent,
    Error,
}

impl HeartbeatOutcome {
    fn as_str(self) -> &'static str {
        match self {
            HeartbeatOutcome::Posted => "posted",
            HeartbeatOutcome::Silent => "silent",
            HeartbeatOutcome::Error => "error",
        }
    }
}

/// How many heartbeat intervals back a restart reads sends into the send record.
const HEARTBEAT_SEND_RESTORE_INTERVALS: i64 = 3;

/// How many sends the send record keeps, and how many run results.
const HEARTBEAT_SENDS: usize = 10;

/// One message an earlier run sent.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RecordedSend {
    place: String,
    text: String,
    at: i64,
}

/// One run's result.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RunReport {
    text: String,
    at: i64,
}

/// The newest `HEARTBEAT_SENDS` messages earlier runs sent, newest first, with a
/// repeated message kept once. A heartbeat runs several checks, so the record
/// holds sends about several incidents, also in one channel. `reports` are the
/// results of the runs since the oldest kept send, newest first: a run that sends
/// reports only what it sent where, so an earlier result can be the one that
/// shows a condition cleared. `checks` is the Heartbeat document the sends were
/// made under: a run under other checks drops the record.
#[derive(Debug, Clone, PartialEq, Eq)]
struct HeartbeatSendRecord {
    checks: String,
    sends: Vec<RecordedSend>,
    reports: Vec<RunReport>,
}

/// The record with `sends` made at `at` under `checks`, each replacing an older send of the same text to the same place.
fn merge_sends(
    record: Option<HeartbeatSendRecord>,
    sends: &[SentMessageEntry],
    at: i64,
    checks: &str,
) -> Option<HeartbeatSendRecord> {
    if sends.is_empty() {
        return record;
    }
    let fresh: Vec<RecordedSend> = sends
        .iter()
        .map(|send| RecordedSend {
            place: send.place.clone(),
            text: send.text.clone(),
            at,
        })
        .collect();
    let (old_sends, old_reports) = match record {
        Some(record) => (record.sends, record.reports),
        None => (Vec::new(), Vec::new()),
    };
    let kept = old_sends.into_iter().filter(|old| {
        !fresh
            .iter()
            .any(|send| send.place == old.place && send.text == old.text)
    });
    let merged: Vec<RecordedSend> = fresh
        .iter()
        .cloned()
        .chain(kept)
        .take(HEARTBEAT_SENDS)
        .collect();
    Some(with_reports(checks.to_string(), merged, old_reports))
}

/// The record with a run's result added, newest first.
fn add_report(record: HeartbeatSendRecord, text: &str, at: i64) -> HeartbeatSendRecord {
    let mut reports = vec![RunReport {
        text: text.to_string(),
        at,
    }];
    reports.extend(record.reports);
    with_reports(record.checks, record.sends, reports)
}

/// The newest `HEARTBEAT_SENDS` results of the runs since the oldest send the record keeps.
fn with_reports(
    checks: String,
    sends: Vec<RecordedSend>,
    reports: Vec<RunReport>,
) -> HeartbeatSendRecord {
    let since = sends.last().map(|send| send.at).unwrap_or(i64::MIN);
    let reports = reports
        .into_iter()
        .filter(|report| report.at >= since)
        .take(HEARTBEAT_SENDS)
        .collect();
    HeartbeatSendRecord {
        checks,
        sends,
        reports,
    }
}

/// A stored `toolCalls` column as records; an entry that is not one is skipped.
fn stored_tool_calls(stored: Option<&Value>) -> Vec<ToolCallRecord> {
    match stored {
        Some(Value::Array(entries)) => entries
            .iter()
            .filter_map(|entry| serde_json::from_value(entry.clone()).ok())
            .collect(),
        _ => Vec::new(),
    }
}

// ============================================================================
// Types
// ============================================================================

/// How a caller anchors the schedule.
///
/// `KeepSchedule` leaves the next cycle where it is, so a restart or any
/// re-registration that is not an interval change cannot defer a check.
/// `NewInterval` starts a fresh interval from now, which is what a user
/// changing the cadence asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HeartbeatSchedule {
    KeepSchedule,
    NewInterval,
}

impl HeartbeatSchedule {
    pub fn as_str(self) -> &'static str {
        match self {
            HeartbeatSchedule::KeepSchedule => "keep-schedule",
            HeartbeatSchedule::NewInterval => "new-interval",
        }
    }
}

/// The prompt a timed heartbeat runs with; its checks are in the system prompt.
pub const HEARTBEAT_PROMPT: &str = "Perform your heartbeat check now.";

/// The registered heartbeat of this process.
struct HeartbeatState {
    user_id: String,
    agent_id: String,
    /// The one timer this state may hold.
    timeout: Option<tokio::task::AbortHandle>,
    interval_ms: i64,
    /// Absolute time the next cycle is due, in epoch milliseconds.
    due_at: i64,
    last_run: Option<DateTime<Utc>>,
    is_running: bool,
    consecutive_errors: i64,
    /// What earlier runs sent, and what the newest run reported. A run reads no
    /// history, so this tells it about earlier sends.
    last_send: Option<HeartbeatSendRecord>,
    /// The restore of the send record. Every run waits for it.
    restored: Shared<BoxFuture<'static, ()>>,
}

/// A shared handle to the registered heartbeat, compared by identity.
type StateHandle = Arc<Mutex<HeartbeatState>>;

/// What a heartbeat run did: `should_skip` when it posted nothing, and its text
/// or the reason it skipped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatResult {
    pub should_skip: bool,
    pub text: String,
}

impl HeartbeatResult {
    fn skipped(text: impl Into<String>) -> Self {
        HeartbeatResult {
            should_skip: true,
            text: text.into(),
        }
    }
}

/// The messages a source holds for a heartbeat, oldest first, and the ids that name them.
#[derive(Debug, Clone, Default)]
pub struct PendingTriggerMessages {
    pub messages: Vec<ChannelTriggerMessage>,
    pub ids: Vec<String>,
    /// The channel the messages were posted in.
    pub place: Option<TriggerPlace>,
}

/// A channel that queues messages to start the heartbeat. A timer heartbeat
/// reads every registered source, so nothing queued waits for a trigger. A run
/// removes the messages it read once it ends, so a restart before then leaves
/// them for the next run.
#[async_trait]
pub trait HeartbeatTriggerSource: Send + Sync {
    /// The channel's adapter name; reported as the heartbeat's trigger.
    fn channel(&self) -> ChatPlatform;
    /// How the prompt names the channel's platform.
    fn platform(&self) -> &str;
    /// Every message queued for `agent_id`. They stay queued until `remove`.
    async fn pending(&self, agent_id: &str) -> anyhow::Result<PendingTriggerMessages>;
    /// Forget the messages a run answered.
    async fn remove(&self, ids: &[String]) -> anyhow::Result<()>;
}

/// The messages one run read, by the source that holds them.
type ReadMessages = Vec<(Arc<dyn HeartbeatTriggerSource>, Vec<String>)>;

/// A run, as `pending_work` holds it until the run ends: the messages it read, by channel.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct HeartbeatWork {
    read: IndexMap<ChatPlatform, Vec<String>>,
}

/// Whether `trigger_from` started a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TriggerOutcome {
    Queued,
    Ignored,
}

impl TriggerOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            TriggerOutcome::Queued => "queued",
            TriggerOutcome::Ignored => "ignored",
        }
    }
}

/// What started a run, for its telemetry: the timer, or the channel whose messages did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeartbeatTriggerKind {
    Timer,
    Channel(ChatPlatform),
}

impl HeartbeatTriggerKind {
    fn as_str(self) -> &'static str {
        match self {
            HeartbeatTriggerKind::Timer => "timer",
            HeartbeatTriggerKind::Channel(platform) => platform.as_str(),
        }
    }
}

/// The heartbeat as the status endpoint reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatStatus {
    pub is_active: bool,
    #[serde(with = "crate::support::serde_iso::option")]
    pub last_run: Option<DateTime<Utc>>,
    pub is_running: bool,
    pub consecutive_errors: i64,
    pub interval_ms: Option<i64>,
}

/// A delay for the log line: seconds under a minute, whole minutes above it.
fn format_delay(delay_ms: i64) -> String {
    let round = |value: f64| (value + 0.5).floor() as i64;
    if delay_ms < 60_000 {
        return format!("{}s", round(delay_ms as f64 / 1000.0));
    }
    format!("{}min", round(delay_ms as f64 / 60_000.0))
}

/// The error text a run reports: the error's message.
fn error_message(error: &anyhow::Error) -> String {
    error.to_string()
}

// ============================================================================
// Heartbeat Service
// ============================================================================

pub struct HeartbeatService {
    heartbeat_state: Mutex<Option<StateHandle>>,
    trigger_sources: Mutex<Vec<Arc<dyn HeartbeatTriggerSource>>>,
    /// A run stopped the process on `MAX_RESUME_ATTEMPTS` boots in a row, so the boot does not start the check at once.
    given_up: AtomicBool,
}

impl HeartbeatService {
    pub fn new() -> Self {
        Self {
            heartbeat_state: Mutex::new(None),
            trigger_sources: Mutex::new(Vec::new()),
            given_up: AtomicBool::new(false),
        }
    }

    pub fn register_trigger_source(&self, source: Arc<dyn HeartbeatTriggerSource>) {
        self.trigger_sources.lock().push(source);
    }

    fn sources(&self) -> Vec<Arc<dyn HeartbeatTriggerSource>> {
        self.trigger_sources.lock().clone()
    }

    fn current(&self) -> Option<StateHandle> {
        self.heartbeat_state.lock().clone()
    }

    /// The boot step for runs a restart stopped. A check that is still due, and the
    /// messages a run read, start a run again. A run the attempt bound gave up
    /// answers its messages, and the next check is an interval away.
    pub async fn resume(
        &self,
        _items: Vec<PendingWorkItem>,
        given_up: Vec<PendingWorkItem>,
    ) -> anyhow::Result<()> {
        if given_up.is_empty() {
            return Ok(());
        }
        log_warn!(
            "[Heartbeat] A run stopped the runtime on {} boots in a row; skipping it",
            MAX_RESUME_ATTEMPTS
        );
        self.given_up.store(true, Ordering::SeqCst);
        for item in given_up {
            let work: HeartbeatWork = serde_json::from_value(item.payload)?;
            for source in self.sources() {
                let ids = work
                    .read
                    .get(&source.channel())
                    .cloned()
                    .unwrap_or_default();
                source.remove(&ids).await?;
            }
        }
        Ok(())
    }

    /// Register the heartbeat and arm its timer. An agent whose heartbeat is
    /// STOPPED is not started. Re-registration keeps the live state: a run in flight
    /// writes its own fields to it, and the send record belongs to the agent rather
    /// than to the timer.
    pub fn start_heartbeat(&'static self, agent: &AgentWorkspace, schedule: HeartbeatSchedule) {
        // Heartbeat enablement is persisted in the database.
        // If the agent is marked STOPPED, we don't start a timer on runtime startup.
        if agent.heartbeat_status == AgentHeartbeatStatus::Stopped {
            log_info!("[Heartbeat] Not starting (status: STOPPED)");
            return;
        }

        let interval_ms = agent.heartbeat_interval_ms;
        let now = now_ms();

        // Re-registration keeps the live state object: a run in flight writes its
        // own fields to it, and the send record belongs to the agent rather than to
        // the timer.
        let state = match self.current() {
            Some(state) => state,
            None => self.register_state(agent, interval_ms, now),
        };
        {
            let mut s = state.lock();
            s.interval_ms = interval_ms;
            if schedule == HeartbeatSchedule::NewInterval {
                s.due_at = now + interval_ms;
            }
        }
        if schedule == HeartbeatSchedule::NewInterval {
            self.persist_schedule(&state);
        }

        let delay_ms = self.arm_timer(&state);

        // Fire-and-forget persistence (don't block startup/management call).
        tokio::spawn(async {
            if let Err(err) = AGENT_STATUS_SERVICE
                .update_agent_heartbeat_status(AgentHeartbeatStatus::Enabled)
                .await
            {
                log_warn!("[Heartbeat] Failed to persist ENABLED status: {}", err);
            }
        });

        log_info!(
            "[Heartbeat] Started (interval: {}min, next check in {})",
            js::number_text(interval_ms as f64 / 60000.0),
            format_delay(delay_ms)
        );
        track_event(
            "heartbeat started",
            Some(&agent.user_id),
            Some(IndexMap::from([
                ("agent.id".to_string(), agent.id.clone()),
                ("heartbeat.interval_ms".to_string(), interval_ms.to_string()),
            ])),
        );
    }

    /// First registration in this process: the schedule comes off the stored row.
    fn register_state(
        &'static self,
        agent: &AgentWorkspace,
        interval_ms: i64,
        now: i64,
    ) -> StateHandle {
        let given_up = self.given_up.load(Ordering::SeqCst);
        let state: StateHandle = Arc::new(Mutex::new(HeartbeatState {
            user_id: agent.user_id.clone(),
            agent_id: agent.id.clone(),
            timeout: None,
            interval_ms,
            due_at: if given_up {
                now + interval_ms
            } else {
                heartbeat_due_at(
                    agent.next_heartbeat_at,
                    agent.last_heartbeat,
                    interval_ms,
                    now,
                )
            },
            last_run: agent.last_heartbeat,
            is_running: false,
            consecutive_errors: 0,
            last_send: None,
            restored: futures::future::ready(()).boxed().shared(),
        }));

        *self.heartbeat_state.lock() = Some(Arc::clone(&state));
        if given_up {
            self.given_up.store(false, Ordering::SeqCst);
            self.persist_schedule(&state);
        }
        let restore = tokio::spawn(Self::restore_send_record(
            Arc::clone(&state),
            agent.heartbeat_md.clone(),
        ));
        state.lock().restored = async move {
            let _ = restore.await;
        }
        .boxed()
        .shared();
        state
    }

    /// The send record holds the sends and results of the runs of the last
    /// `HEARTBEAT_SEND_RESTORE_INTERVALS` intervals after the newest revision of the
    /// Heartbeat document, read from the stored heartbeat rows of the web threads.
    /// The trades: a run that posted nothing is not stored, so the record can miss a
    /// report that a condition cleared; a send older than the window is sent again;
    /// and a document written straight into the database has no revision, so
    /// earlier sends are read as made under it.
    async fn restore_send_record(state: StateHandle, checks: String) {
        let (agent_id, interval_ms) = {
            let s = state.lock();
            (s.agent_id.clone(), s.interval_ms)
        };
        let read: anyhow::Result<Option<HeartbeatSendRecord>> = async {
            let owner = agent_id.clone();
            let rows: Vec<(String, DateTime<Utc>, Option<Value>)> = crate::db::run(move |conn| {
                Ok(m::conversation_messages
                    .inner_join(t::conversation_threads)
                    .filter(m::role.eq(MessageRole::Agent))
                    .filter(m::triggered_by.eq(MessageTrigger::Heartbeat))
                    .filter(t::agent_id.eq(&owner))
                    .filter(t::external_thread_id.is_null())
                    .order(m::created_at.desc())
                    .limit(SEND_RECORD_ROWS)
                    .select((m::content, m::created_at, m::tool_calls))
                    .load(conn)?)
            })
            .await?;
            let owner = agent_id.clone();
            let edited = crate::db::run(move |conn| {
                DOCUMENT_REVISION_SERVICE.newest(conn, &owner, WorkspaceDocField::HeartbeatMd)
            })
            .await?;
            let since = (now_ms() - HEARTBEAT_SEND_RESTORE_INTERVALS * interval_ms).max(
                edited
                    .map(|revision| revision.created_at.timestamp_millis())
                    .unwrap_or(0),
            );
            let sends: Vec<Vec<SentMessageEntry>> = rows
                .iter()
                .map(|(_, _, tool_calls)| {
                    sent_message_list(&stored_tool_calls(tool_calls.as_ref()))
                })
                .collect();
            let mut record: Option<HeartbeatSendRecord> = None;
            // Oldest first and in a live run's order, so a newer copy of a send replaces an older one.
            for i in (0..rows.len()).rev() {
                let at = rows[i].1.timestamp_millis();
                if at < since {
                    continue;
                }
                record = merge_sends(record, &sends[i], at, &checks);
                // A live run records no result for a run without a reply or one stopped by the spending limit.
                let text = js::trim(&rows[i].0);
                if let Some(current) = record.take() {
                    record = Some(
                        if !text.is_empty()
                            && text != WITHHELD_RUN_TEXT
                            && text != HEARTBEAT_BUDGET_NOTICE
                        {
                            add_report(current, text, at)
                        } else {
                            current
                        },
                    );
                }
            }
            Ok(record)
        }
        .await;
        match read {
            Ok(record) => state.lock().last_send = record,
            Err(err) => {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[Heartbeat] Could not read the send record"
                );
            }
        }
    }

    /// Trigger messages a restart left unanswered get their heartbeat now, rather
    /// than at the next timer run.
    pub async fn answer_pending_triggers(&'static self) -> anyhow::Result<()> {
        let Some(state) = self.current() else {
            return Ok(());
        };
        let agent_id = state.lock().agent_id.clone();
        for source in self.sources() {
            let pending = source.pending(&agent_id).await?;
            if !pending.ids.is_empty() && self.trigger_from(&source) == TriggerOutcome::Queued {
                return Ok(());
            }
        }
        Ok(())
    }

    /// Arm the one timer this state may hold, and answer the delay it waits. The
    /// timer only starts the cycle, so clearing it never stops a cycle that runs.
    fn arm_timer(&'static self, state: &StateHandle) -> i64 {
        let mut s = state.lock();
        if let Some(timeout) = s.timeout.take() {
            timeout.abort();
        }

        let delay_ms = heartbeat_delay_ms(s.due_at, s.interval_ms, now_ms());
        let timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms.max(0) as u64)).await;
            tokio::spawn(self.on_timer());
        });
        s.timeout = Some(timer.abort_handle());
        delay_ms
    }

    /// The timer fired. A cycle runs only when one is due: the delay is capped, and
    /// a run started elsewhere may have moved the due time. The chain re-arms
    /// whatever the run did, so no failure can leave the heartbeat silent for the
    /// life of the process. A stop clears the state, and the identity check then
    /// declines to arm a timer nothing owns.
    async fn on_timer(&'static self) {
        let Some(state) = self.current() else {
            return;
        };

        let due_at = state.lock().due_at;
        if now_ms() >= due_at {
            // `execute_heartbeat` answers for a failed run itself.
            self.execute_heartbeat().await;
        }
        if self
            .current()
            .is_some_and(|current| Arc::ptr_eq(&current, &state))
        {
            self.arm_timer(&state);
        }
    }

    /// One cycle happened. The in-memory deadline and the persisted one move
    /// together, so the next process arms the same one. A write that fails logs a
    /// warning and leaves the persisted deadline behind, which reads as overdue on
    /// the next boot, so a check runs early.
    async fn record_cycle(&self, state: &StateHandle) {
        let ran_at = Utc::now();
        {
            let mut s = state.lock();
            s.last_run = Some(ran_at);
            s.due_at = ran_at.timestamp_millis() + s.interval_ms;
        }
        self.write_schedule(state, Some(ran_at)).await;
    }

    /// A run ended: the next check is an interval away, and the trigger messages it
    /// read are answered. Called after the delivery, so a restart before it runs
    /// the check again rather than losing its alert.
    async fn end_cycle(&self, state: &StateHandle, read: &ReadMessages) {
        self.record_cycle(state).await;
        self.end_run(state, read).await;
    }

    /// Kept as pending work from before the model call until the run ends, so the
    /// attempt bound gives up a run that stops the process on every boot.
    async fn begin_run(&self, state: &StateHandle, read: &ReadMessages) {
        let work = HeartbeatWork {
            read: read
                .iter()
                .map(|(source, ids)| (source.channel(), ids.clone()))
                .collect(),
        };
        let agent_id = state.lock().agent_id.clone();
        let payload = serde_json::to_value(&work).unwrap_or(Value::Null);
        if let Err(err) = PENDING_WORK_SERVICE
            .begin(PendingWorkKind::Heartbeat, &agent_id, payload)
            .await
        {
            log_warn!(
                json!({ "err": err_json(&err) }),
                "[Heartbeat] Could not record the run"
            );
        }
    }

    /// The run ended: the messages it read are answered.
    async fn end_run(&self, state: &StateHandle, read: &ReadMessages) {
        for (source, ids) in read {
            if let Err(err) = source.remove(ids).await {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[Heartbeat] Could not remove the {} messages this run answered",
                    source.platform()
                );
            }
        }
        let agent_id = state.lock().agent_id.clone();
        PENDING_WORK_SERVICE.finish(PendingWorkKind::Heartbeat, agent_id);
    }

    /// Persist a deadline no run produced, so a cadence change survives a restart.
    /// Fire-and-forget: the caller is `start_heartbeat`, which a boot and a
    /// management route both call and neither waits on a write for.
    fn persist_schedule(&'static self, state: &StateHandle) {
        let state = Arc::clone(state);
        tokio::spawn(async move { self.write_schedule(&state, None).await });
    }

    /// The one write of the schedule columns. `ran_at` moves the last-run column
    /// too, and only a cycle passes it, so a cadence change reports no heartbeat.
    async fn write_schedule(&self, state: &StateHandle, ran_at: Option<DateTime<Utc>>) {
        let due_at = state.lock().due_at;
        if let Err(err) = AGENT_STATUS_SERVICE
            .update_heartbeat_schedule(HeartbeatScheduleUpdate {
                next_heartbeat_at: crate::support::from_ms(due_at),
                last_heartbeat: ran_at,
            })
            .await
        {
            log_warn!("[Heartbeat] Failed to persist the schedule: {}", err);
        }
    }

    /// Stop the heartbeat: persist STOPPED, emit `heartbeat stopped` when one was
    /// running, and clear the timer.
    pub fn stop_heartbeat(&self) {
        tokio::spawn(async {
            if let Err(err) = AGENT_STATUS_SERVICE
                .update_agent_heartbeat_status(AgentHeartbeatStatus::Stopped)
                .await
            {
                log_warn!("[Heartbeat] Failed to persist STOPPED status: {}", err);
            }
        });

        // Emit only when a heartbeat was actually running — a no-op stop is not
        // a real event and would lack agent.id.
        if let Some(state) = self.current() {
            let (user_id, agent_id) = {
                let s = state.lock();
                (s.user_id.clone(), s.agent_id.clone())
            };
            track_event(
                "heartbeat stopped",
                Some(&user_id),
                Some(IndexMap::from([("agent.id".to_string(), agent_id)])),
            );
        }

        self.clear_heartbeat_timer();
    }

    fn clear_heartbeat_timer(&self) {
        let state = self.heartbeat_state.lock().take();
        if let Some(state) = state
            && let Some(timeout) = state.lock().timeout.take()
        {
            timeout.abort();
        }
    }

    /// Run one heartbeat check now, with every channel's pending trigger messages.
    /// Every failure is answered in the result, never returned.
    pub async fn execute_heartbeat(&'static self) -> HeartbeatResult {
        let start_time = now_ms();
        let Some(state) = self.current() else {
            return HeartbeatResult::skipped("No registered heartbeat for this agent");
        };

        {
            let mut s = state.lock();
            if s.is_running {
                return HeartbeatResult::skipped("Already running");
            }
            s.is_running = true;
        }

        let mut read: ReadMessages = Vec::new();
        let mut delivering = false;
        let result = match self
            .run_timer_cycle(&state, start_time, &mut read, &mut delivering)
            .await
        {
            Ok(result) => result,
            Err(error) => {
                self.fail_timer_cycle(&state, start_time, &read, delivering, error)
                    .await
            }
        };
        state.lock().is_running = false;
        result
    }

    /// The body of a timed run.
    async fn run_timer_cycle(
        &'static self,
        state: &StateHandle,
        start_time: i64,
        read: &mut ReadMessages,
        delivering: &mut bool,
    ) -> anyhow::Result<HeartbeatResult> {
        let shutdown = PENDING_WORK_SERVICE.shutdown_signal();
        let (user_id, agent_id) = {
            let s = state.lock();
            (s.user_id.clone(), s.agent_id.clone())
        };
        log_info!("[Heartbeat] Executing");

        // Every channel's pending trigger messages ride along so none waits for its
        // trigger. They are removed when this run ends, so a restart before then keeps them.
        let mut triggers: Vec<HeartbeatTrigger> = Vec::new();
        for source in self.sources() {
            let pending = source.pending(&agent_id).await?;
            if pending.messages.is_empty() {
                continue;
            }
            log_info!(
                "[Heartbeat] Picked up {} pending {} message(s) during timer heartbeat",
                pending.messages.len(),
                source.platform()
            );
            triggers.push(HeartbeatTrigger {
                platform: source.platform().to_string(),
                place: pending.place,
                messages: pending.messages,
            });
            read.push((source, pending.ids));
        }
        let triggered = !triggers.is_empty();
        self.begin_run(state, read).await;
        let (checks, delivery) = self.read_checks(state).await?;

        // Invoke LLM directly (in-process, no HTTP)
        let posting_ceiling = DELIVERY_TARGET_SERVICE
            .ceiling(&agent_id, &delivery)
            .await?;
        let invoke_result = invoke(InvokeRequest {
            user_id: user_id.clone(),
            agent_id: agent_id.clone(),
            mode: InvokeMode::Heartbeat,
            posting_ceiling: Some(posting_ceiling),
            prompt: if triggered {
                self.build_triggered_heartbeat_prompt(&triggers)
            } else {
                self.build_heartbeat_prompt()
            },
            last_send: self.send_record_for_prompt(state),
            heartbeat_triggers: triggered.then_some(triggers),
            abort_signal: Some(shutdown.clone()),
            ..InvokeRequest::default()
        })
        .await?;
        // A shutdown stopped the run. One that posted nothing stays due with its
        // messages queued, so the next boot runs it; one that posted already reached
        // people, so it ends. From here the run delivers, so a shutdown that starts
        // later lets it end.
        if shutdown.is_cancelled() {
            if self.keep_stopped_run(state, &invoke_result).await? {
                self.end_cycle(state, read).await;
            }
            return Ok(HeartbeatResult::skipped("Stopped by shutdown"));
        }
        *delivering = true;
        self.note_sends(state, &invoke_result.tool_calls, &checks);

        // Budget exceeded — skip and reset error streak so the timer keeps running.
        // The cycle still happened, so the next one is a full interval away.
        if invoke_result
            .error
            .as_ref()
            .is_some_and(|error| error.kind == InvokeErrorType::BudgetExceeded)
        {
            state.lock().consecutive_errors = 0;
            self.end_cycle(state, read).await;
            OUTBOUND_MESSAGE_SERVICE
                .keep_withheld_run(WithheldRun {
                    agent_id: agent_id.clone(),
                    user_id: user_id.clone(),
                    thread_id: None,
                    content: HEARTBEAT_BUDGET_NOTICE.to_string(),
                    triggered_by: MessageTrigger::Heartbeat,
                    trigger_name: None,
                    tool_calls: invoke_result.tool_calls.clone(),
                })
                .await?;
            log_info!("[Heartbeat] Skipping — budget exceeded");
            self.track_heartbeat(
                state,
                HeartbeatTriggerKind::Timer,
                "budget_exceeded",
                start_time,
                0,
            );
            return Ok(HeartbeatResult::skipped("Budget exceeded"));
        }

        let response_text =
            last_response_text(invoke_result.steps.iter().map(|step| step.text.as_str()));
        if invoke_result.error.is_none() {
            self.note_report(state, &response_text);
        }
        self.log_steps(&response_text, &invoke_result.steps, None);
        let outcome = self
            .finish_run(state, &delivery, &invoke_result, &response_text)
            .await?;

        self.end_cycle(state, read).await;

        state.lock().consecutive_errors = 0;

        log_info!(
            "[Heartbeat] Completed in {}ms: {}",
            now_ms() - start_time,
            outcome.as_str()
        );
        self.track_heartbeat(
            state,
            HeartbeatTriggerKind::Timer,
            outcome.as_str(),
            start_time,
            sent_message_list(&invoke_result.tool_calls).len(),
        );
        Ok(HeartbeatResult {
            should_skip: outcome == HeartbeatOutcome::Silent,
            text: response_text,
        })
    }

    /// A timed run failed: it is still a cycle, and five in a row stop the heartbeat.
    async fn fail_timer_cycle(
        &self,
        state: &StateHandle,
        start_time: i64,
        read: &ReadMessages,
        delivering: bool,
        error: anyhow::Error,
    ) -> HeartbeatResult {
        let err_msg = error_message(&error);
        log_error!("[Heartbeat] Failed: {}", err_msg);
        if PENDING_WORK_SERVICE.shutdown_signal().is_cancelled() && !delivering {
            return HeartbeatResult::skipped(err_msg);
        }

        // A failed run is still a cycle. It spaces the error streak one interval
        // apart, which is what the auto-stop below is counting.
        self.end_cycle(state, read).await;

        self.track_heartbeat(state, HeartbeatTriggerKind::Timer, "error", start_time, 0);
        let errors = {
            let mut s = state.lock();
            s.consecutive_errors += 1;
            s.consecutive_errors
        };
        if errors >= 5 {
            log_error!("[Heartbeat] Stopping: too many consecutive errors");
            self.stop_heartbeat();
        }

        HeartbeatResult::skipped(err_msg)
    }

    // ========================================================================
    // Channel-Triggered Heartbeat
    // ========================================================================

    /// Notify that `source` has new messages queued in the DB.
    /// Fires a heartbeat if not already running. If already running, the
    /// messages stay queued for the next run.
    pub fn trigger_from(&'static self, source: &Arc<dyn HeartbeatTriggerSource>) -> TriggerOutcome {
        let Some(state) = self.current() else {
            log_warn!(
                "[Heartbeat] No heartbeat state — ignoring {} trigger",
                source.platform()
            );
            return TriggerOutcome::Ignored;
        };

        log_info!("[Heartbeat] {} trigger notification", source.platform());

        if state.lock().is_running {
            log_info!("[Heartbeat] Heartbeat already running, the messages wait for the next run");
            return TriggerOutcome::Ignored;
        }

        // The run claims the state now, as the call it starts does before its first
        // wait; errors are handled inside.
        let label = format!("{}-triggered", source.platform());
        log_info!("[Heartbeat] Starting {} heartbeat", label);
        let started_at = now_ms();
        {
            let mut s = state.lock();
            if s.is_running {
                log_info!("[Heartbeat] Heartbeat already running or no state");
                return TriggerOutcome::Queued;
            }
            s.is_running = true;
        }
        let source = Arc::clone(source);
        tokio::spawn(async move {
            self.execute_channel_triggered_heartbeat(state, source, started_at)
                .await;
        });

        TriggerOutcome::Queued
    }

    /// Execute a single channel-triggered heartbeat over the pending messages, and
    /// remove them once it ends. Messages that arrive during execution wait for the
    /// next run. The caller has marked the state running.
    async fn execute_channel_triggered_heartbeat(
        &'static self,
        state: StateHandle,
        source: Arc<dyn HeartbeatTriggerSource>,
        started_at: i64,
    ) {
        let label = format!("{}-triggered", source.platform());
        let mut read: ReadMessages = Vec::new();
        let mut delivering = false;

        let ran = self
            .run_channel_cycle(
                &state,
                &source,
                &label,
                started_at,
                &mut read,
                &mut delivering,
            )
            .await;
        if let Err(error) = ran {
            let err_msg = error_message(&error);
            log_error!("[Heartbeat] {} heartbeat failed: {}", label, err_msg);
            if !PENDING_WORK_SERVICE.shutdown_signal().is_cancelled() || delivering {
                // A failed run answered its messages too; kept, they would fail every run after it.
                self.end_run(&state, &read).await;
                self.track_heartbeat(
                    &state,
                    HeartbeatTriggerKind::Channel(source.channel()),
                    "error",
                    started_at,
                    0,
                );
                state.lock().consecutive_errors += 1;
            }
        }
        state.lock().is_running = false;
    }

    /// The body of a channel-triggered run.
    async fn run_channel_cycle(
        &'static self,
        state: &StateHandle,
        source: &Arc<dyn HeartbeatTriggerSource>,
        label: &str,
        started_at: i64,
        read: &mut ReadMessages,
        delivering: &mut bool,
    ) -> anyhow::Result<()> {
        let shutdown = PENDING_WORK_SERVICE.shutdown_signal();
        let (user_id, agent_id) = {
            let s = state.lock();
            (s.user_id.clone(), s.agent_id.clone())
        };
        let pending = source.pending(&agent_id).await?;
        *read = vec![(Arc::clone(source), pending.ids.clone())];

        if pending.messages.is_empty() {
            log_info!("[Heartbeat] No {} messages to process", source.platform());
            return Ok(());
        }

        log_info!(
            "[Heartbeat] Executing {} heartbeat with {} message(s)",
            label,
            pending.messages.len()
        );

        let start_time = now_ms();
        let triggers = vec![HeartbeatTrigger {
            platform: source.platform().to_string(),
            place: None,
            messages: pending.messages,
        }];
        self.begin_run(state, read).await;
        let (checks, delivery) = self.read_checks(state).await?;

        let posting_ceiling = DELIVERY_TARGET_SERVICE
            .ceiling(&agent_id, &delivery)
            .await?;
        let invoke_result = invoke(InvokeRequest {
            user_id: user_id.clone(),
            agent_id: agent_id.clone(),
            mode: InvokeMode::Heartbeat,
            posting_ceiling: Some(posting_ceiling),
            prompt: self.build_triggered_heartbeat_prompt(&triggers),
            last_send: self.send_record_for_prompt(state),
            heartbeat_triggers: Some(triggers),
            abort_signal: Some(shutdown.clone()),
            ..InvokeRequest::default()
        })
        .await?;
        // A shutdown stopped the run. The messages of one that posted nothing stay
        // queued for the next boot; one that posted already answered them.
        if shutdown.is_cancelled() {
            if self.keep_stopped_run(state, &invoke_result).await? {
                self.end_cycle(state, read).await;
            }
            return Ok(());
        }
        *delivering = true;
        self.note_sends(state, &invoke_result.tool_calls, &checks);

        let trigger = HeartbeatTriggerKind::Channel(source.channel());
        // Budget exceeded — skip gracefully
        if invoke_result
            .error
            .as_ref()
            .is_some_and(|error| error.kind == InvokeErrorType::BudgetExceeded)
        {
            state.lock().consecutive_errors = 0;
            self.end_run(state, read).await;
            OUTBOUND_MESSAGE_SERVICE
                .keep_withheld_run(WithheldRun {
                    agent_id: agent_id.clone(),
                    user_id: user_id.clone(),
                    thread_id: None,
                    content: HEARTBEAT_BUDGET_NOTICE.to_string(),
                    triggered_by: MessageTrigger::Heartbeat,
                    trigger_name: None,
                    tool_calls: invoke_result.tool_calls.clone(),
                })
                .await?;
            log_info!("[Heartbeat] {} heartbeat skipped — budget exceeded", label);
            self.track_heartbeat(state, trigger, "budget_exceeded", started_at, 0);
            return Ok(());
        }

        let response_text =
            last_response_text(invoke_result.steps.iter().map(|step| step.text.as_str()));
        if invoke_result.error.is_none() {
            self.note_report(state, &response_text);
        }
        let step_label = format!("{}-triggered", source.channel().as_str());
        self.log_steps(&response_text, &invoke_result.steps, Some(&step_label));
        let outcome = self
            .finish_run(state, &delivery, &invoke_result, &response_text)
            .await?;

        self.end_cycle(state, read).await;

        state.lock().consecutive_errors = 0;

        log_info!(
            "[Heartbeat] {} heartbeat completed in {}ms: {}",
            label,
            now_ms() - start_time,
            outcome.as_str()
        );
        self.track_heartbeat(
            state,
            trigger,
            outcome.as_str(),
            started_at,
            sent_message_list(&invoke_result.tool_calls).len(),
        );
        Ok(())
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    /// Emit a product-telemetry event for a finished heartbeat run. `result` is a
    /// `HeartbeatOutcome` or `budget_exceeded`.
    fn track_heartbeat(
        &self,
        state: &StateHandle,
        trigger: HeartbeatTriggerKind,
        result: &str,
        start_time: i64,
        messages_sent: usize,
    ) {
        let (user_id, agent_id) = {
            let s = state.lock();
            (s.user_id.clone(), s.agent_id.clone())
        };
        track_event(
            "heartbeat completed",
            Some(&user_id),
            Some(IndexMap::from([
                ("agent.id".to_string(), agent_id),
                (
                    "heartbeat.trigger".to_string(),
                    trigger.as_str().to_string(),
                ),
                ("heartbeat.result".to_string(), result.to_string()),
                (
                    "heartbeat.messages_sent".to_string(),
                    messages_sent.to_string(),
                ),
                (
                    "heartbeat.duration_ms".to_string(),
                    (now_ms() - start_time).to_string(),
                ),
            ])),
        );
    }

    fn log_steps(&self, response_text: &str, steps: &[InvokeStep], label: Option<&str>) {
        let prefix = label.map(|label| format!("{label} ")).unwrap_or_default();
        log_info!(
            "[Heartbeat] LLM response: \"{}\" with {} {}step(s)",
            js::slice16(response_text, 0, 100),
            steps.len(),
            prefix
        );
        for (i, step) in steps.iter().enumerate() {
            let tool_names = step
                .tool_calls
                .iter()
                .map(|call| call.tool.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            let tools = if tool_names.is_empty() {
                String::new()
            } else {
                format!(" tools=[{tool_names}]")
            };
            let text = if step.text.is_empty() {
                " (no text)".to_string()
            } else {
                format!(" text=\"{}\"", js::slice16(&step.text, 0, 120))
            };
            log_info!(
                "[Heartbeat] {}step {}/{}{}{}",
                prefix,
                i + 1,
                steps.len(),
                tools,
                text
            );
        }
    }

    pub fn build_heartbeat_prompt(&self) -> String {
        HEARTBEAT_PROMPT.to_string()
    }

    pub fn build_triggered_heartbeat_prompt(&self, triggers: &[HeartbeatTrigger]) -> String {
        let platforms = triggers
            .iter()
            .map(|trigger| trigger.platform.as_str())
            .collect::<Vec<_>>()
            .join(" and ");
        let channels = if triggers.len() > 1 {
            "channels"
        } else {
            "channel"
        };
        format!(
            "{HEARTBEAT_PROMPT} This heartbeat was triggered by new messages in the monitored {platforms} {channels}."
        )
    }

    /// A run reaches people only through what the agent posted. Its result is kept
    /// as the run's record, except a run that ended in an error, or ran out of steps
    /// before it posted: the agent could not post that, so it goes to the delivery
    /// setting's destination.
    async fn finish_run(
        &self,
        state: &StateHandle,
        delivery: &DeliveryTarget,
        invoke_result: &InvokeResponse,
        response_text: &str,
    ) -> anyhow::Result<HeartbeatOutcome> {
        let (user_id, agent_id) = {
            let s = state.lock();
            (s.user_id.clone(), s.agent_id.clone())
        };
        let sent = sent_message_list(&invoke_result.tool_calls);
        let unposted = invoke_result.step_limit_reached && sent.is_empty();
        if (invoke_result.error.is_some() || unposted) && !response_text.is_empty() {
            DELIVERY_TARGET_SERVICE
                .deliver(
                    &agent_id,
                    &user_id,
                    delivery,
                    response_text,
                    TargetTrigger::Heartbeat,
                    TargetPublishOptions {
                        tool_calls: (!invoke_result.tool_calls.is_empty())
                            .then(|| invoke_result.tool_calls.clone()),
                        ..TargetPublishOptions::default()
                    },
                )
                .await?;
            return Ok(HeartbeatOutcome::Error);
        }
        OUTBOUND_MESSAGE_SERVICE
            .keep_withheld_run(WithheldRun {
                agent_id,
                user_id,
                thread_id: None,
                content: response_text.to_string(),
                triggered_by: MessageTrigger::Heartbeat,
                trigger_name: None,
                tool_calls: invoke_result.tool_calls.clone(),
            })
            .await?;
        Ok(if sent.is_empty() {
            HeartbeatOutcome::Silent
        } else {
            HeartbeatOutcome::Posted
        })
    }

    /// A run's sends join the record, each replacing the older send to its place.
    fn note_sends(&self, state: &StateHandle, tool_calls: &[ToolCallRecord], checks: &str) {
        let sends = sent_message_list(tool_calls);
        let mut s = state.lock();
        let record = s.last_send.take();
        s.last_send = merge_sends(record, &sends, now_ms(), checks);
    }

    /// The Heartbeat document this run checks, and where it may post, once the
    /// restore is done. A record made under other checks is dropped.
    async fn read_checks(&self, state: &StateHandle) -> anyhow::Result<(String, DeliveryTarget)> {
        let (restored, agent_id) = {
            let s = state.lock();
            (s.restored.clone(), s.agent_id.clone())
        };
        restored.await;
        let (heartbeat_md, deliver_to, channel_ids): (String, String, Option<String>) =
            crate::db::run(move |conn| {
                aw::agent_workspaces
                    .filter(aw::id.eq(&agent_id))
                    .select((
                        aw::heartbeat_md,
                        aw::heartbeat_deliver_to,
                        aw::heartbeat_channel_ids,
                    ))
                    .first(conn)
                    .optional()?
                    .ok_or_else(|| anyhow!("No AgentWorkspace found"))
            })
            .await?;
        {
            let mut s = state.lock();
            if s.last_send
                .as_ref()
                .is_some_and(|record| record.checks != heartbeat_md)
            {
                s.last_send = None;
            }
        }
        Ok((
            heartbeat_md,
            DeliveryTarget {
                deliver_to,
                channel_ids: parse_comma_list(channel_ids.as_deref()),
            },
        ))
    }

    /// The record as the prompt reads it: each send with its age.
    fn send_record_for_prompt(&self, state: &StateHandle) -> Option<TaskLastSend> {
        let s = state.lock();
        let record = s.last_send.as_ref()?;
        let first = record.sends.first()?;
        Some(TaskLastSend {
            messages: record
                .sends
                .iter()
                .map(|send| {
                    format!(
                        "- To {} ({}): {}",
                        send.place,
                        format_time_ago(send.at),
                        send.text
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"),
            at: first.at,
            latest_report: None,
            reports: Some(
                record
                    .reports
                    .iter()
                    .map(|report| TaskReport {
                        text: report.text.clone(),
                        at: report.at,
                    })
                    .collect(),
            ),
        })
    }

    /// A message a run sent before a shutdown stopped it stays in history, so the
    /// restored record has it. The unfinished text is no report. Answers whether the run sent.
    async fn keep_stopped_run(
        &self,
        state: &StateHandle,
        invoke_result: &InvokeResponse,
    ) -> anyhow::Result<bool> {
        let (user_id, agent_id) = {
            let s = state.lock();
            (s.user_id.clone(), s.agent_id.clone())
        };
        OUTBOUND_MESSAGE_SERVICE
            .keep_withheld_run(WithheldRun {
                agent_id,
                user_id,
                thread_id: None,
                content: WITHHELD_RUN_TEXT.to_string(),
                triggered_by: MessageTrigger::Heartbeat,
                trigger_name: None,
                tool_calls: invoke_result.tool_calls.clone(),
            })
            .await?;
        Ok(!sent_message_list(&invoke_result.tool_calls).is_empty())
    }

    /// A run's result, so the next run reads whether a finding still held. An empty result says nothing.
    fn note_report(&self, state: &StateHandle, text: &str) {
        let text = js::trim(text);
        let mut s = state.lock();
        if text.is_empty() {
            return;
        }
        if let Some(record) = s.last_send.take() {
            s.last_send = Some(add_report(record, text, now_ms()));
        }
    }

    // ========================================================================
    // Status & Control
    // ========================================================================

    pub fn get_status(&self) -> Option<HeartbeatStatus> {
        let state = self.heartbeat_state.lock().clone()?;
        let state = state.lock();
        Some(HeartbeatStatus {
            is_active: true,
            last_run: state.last_run,
            is_running: state.is_running,
            consecutive_errors: state.consecutive_errors,
            interval_ms: Some(state.interval_ms),
        })
    }

    pub fn stop_all(&self) {
        log_info!("[Heartbeat] Stopping the heartbeat");
        self.clear_heartbeat_timer();
    }

    pub async fn trigger_heartbeat(&'static self) -> HeartbeatResult {
        self.execute_heartbeat().await
    }
}

impl Default for HeartbeatService {
    fn default() -> Self {
        Self::new()
    }
}

pub static HEARTBEAT_SERVICE: LazyLock<HeartbeatService> = LazyLock::new(HeartbeatService::new);

#[cfg(test)]
mod tests {
    use super::*;

    fn send(place: &str, text: &str) -> SentMessageEntry {
        SentMessageEntry {
            target: place.to_string(),
            place: place.to_string(),
            text: text.to_string(),
        }
    }

    #[test]
    fn keeps_a_repeated_send_once_newest_first() {
        let first = merge_sends(None, &[send("#ops", "disk 91%")], 1_000, "checks").unwrap();
        let second = merge_sends(
            Some(first),
            &[send("#ops", "disk 91%"), send("#dev", "build red")],
            2_000,
            "checks",
        )
        .unwrap();
        assert_eq!(
            second.sends,
            vec![
                RecordedSend {
                    place: "#ops".into(),
                    text: "disk 91%".into(),
                    at: 2_000
                },
                RecordedSend {
                    place: "#dev".into(),
                    text: "build red".into(),
                    at: 2_000
                },
            ]
        );
    }

    #[test]
    fn keeps_no_more_than_ten_sends() {
        let mut record = None;
        for i in 0..12 {
            record = merge_sends(record, &[send("#ops", &format!("alert {i}"))], i, "checks");
        }
        let record = record.unwrap();
        assert_eq!(record.sends.len(), HEARTBEAT_SENDS);
        assert_eq!(record.sends[0].text, "alert 11");
    }

    #[test]
    fn keeps_the_reports_since_the_oldest_kept_send() {
        let record = merge_sends(None, &[send("#ops", "disk 91%")], 1_000, "checks").unwrap();
        let record = add_report(record, "disk 91%", 1_000);
        let record = add_report(record, "disk back to 40%", 2_000);
        assert_eq!(
            record
                .reports
                .iter()
                .map(|report| report.text.as_str())
                .collect::<Vec<_>>(),
            vec!["disk back to 40%", "disk 91%"]
        );
        // An older report than the oldest send is dropped.
        let record = with_reports(
            record.checks,
            record.sends,
            vec![RunReport {
                text: "old".into(),
                at: 500,
            }],
        );
        assert!(record.reports.is_empty());
    }

    #[test]
    fn records_nothing_for_a_run_that_sent_nothing() {
        assert_eq!(merge_sends(None, &[], 1_000, "checks"), None);
    }

    #[test]
    fn names_the_platforms_that_triggered_a_run() {
        let service = HeartbeatService::new();
        let trigger = |platform: &str| HeartbeatTrigger {
            platform: platform.into(),
            place: None,
            messages: vec![],
        };
        assert_eq!(
            service.build_triggered_heartbeat_prompt(&[trigger("Slack")]),
            "Perform your heartbeat check now. This heartbeat was triggered by new messages in the monitored Slack channel."
        );
        assert_eq!(
            service.build_triggered_heartbeat_prompt(&[trigger("Slack"), trigger("Teams")]),
            "Perform your heartbeat check now. This heartbeat was triggered by new messages in the monitored Slack and Teams channels."
        );
    }

    #[test]
    fn formats_the_delay_in_seconds_under_a_minute_and_minutes_above() {
        assert_eq!(format_delay(30_000), "30s");
        assert_eq!(format_delay(60_000), "1min");
        assert_eq!(format_delay(28_800_000), "480min");
    }

    #[test]
    fn writes_the_run_record_keyed_by_channel() {
        let work = HeartbeatWork {
            read: IndexMap::from([(ChatPlatform::Slack, vec!["m-1".to_string()])]),
        };
        assert_eq!(
            serde_json::to_value(&work).unwrap(),
            json!({ "read": { "slack": ["m-1"] } })
        );
    }

    #[test]
    fn reads_the_send_record_for_the_prompt_with_each_send_age() {
        let state: StateHandle = Arc::new(Mutex::new(HeartbeatState {
            user_id: "user-1".into(),
            agent_id: "agent-1".into(),
            timeout: None,
            interval_ms: 60_000,
            due_at: 0,
            last_run: None,
            is_running: false,
            consecutive_errors: 0,
            last_send: merge_sends(None, &[send("#ops", "disk 91%")], now_ms(), "checks"),
            restored: futures::future::ready(()).boxed().shared(),
        }));
        let service = HeartbeatService::new();
        let record = service.send_record_for_prompt(&state).unwrap();
        assert_eq!(record.messages, "- To #ops (just now): disk 91%");
        assert_eq!(record.reports, Some(vec![]));

        service.note_report(&state, "  disk still 91%  ");
        let record = service.send_record_for_prompt(&state).unwrap();
        assert_eq!(record.reports.unwrap()[0].text, "disk still 91%");
    }
}
