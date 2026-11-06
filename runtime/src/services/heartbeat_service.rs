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

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::db::models::AgentWorkspace;
use crate::services::channel_adapter_interface::ChatPlatform;
use crate::services::delivery_target_service::DeliveryTarget;
use crate::services::outbound_message_service::SentMessageEntry;
use crate::services::pending_work_service::PendingWorkItem;
use crate::types::{
    ChannelTriggerMessage, HeartbeatTrigger, InvokeResponse, InvokeStep, TaskLastSend,
    ToolCallRecord, TriggerPlace,
};

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

    /// The boot step for runs a restart stopped. A check that is still due, and the
    /// messages a run read, start a run again. A run the attempt bound gave up
    /// answers its messages, and the next check is an interval away.
    pub async fn resume(
        &self,
        items: Vec<PendingWorkItem>,
        given_up: Vec<PendingWorkItem>,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Register the heartbeat and arm its timer. An agent whose heartbeat is
    /// STOPPED is not started. Re-registration keeps the live state: a run in flight
    /// writes its own fields to it, and the send record belongs to the agent rather
    /// than to the timer.
    pub fn start_heartbeat(&self, agent: &AgentWorkspace, schedule: HeartbeatSchedule) {
        todo!()
    }

    /// First registration in this process: the schedule comes off the stored row.
    fn register_state(&self, agent: &AgentWorkspace, interval_ms: i64, now: i64) -> StateHandle {
        todo!()
    }

    /// The send record holds the sends and results of the runs of the last
    /// `HEARTBEAT_SEND_RESTORE_INTERVALS` intervals after the newest revision of the
    /// Heartbeat document, read from the stored heartbeat rows of the web threads.
    /// The trades: a run that posted nothing is not stored, so the record can miss a
    /// report that a condition cleared; a send older than the window is sent again;
    /// and a document written straight into the database has no revision, so
    /// earlier sends are read as made under it.
    async fn restore_send_record(&self, state: StateHandle, checks: String) {
        todo!()
    }

    /// Trigger messages a restart left unanswered get their heartbeat now, rather
    /// than at the next timer run.
    pub async fn answer_pending_triggers(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Arm the one timer this state may hold, and answer the delay it waits.
    fn arm_timer(&self, state: &StateHandle) -> i64 {
        todo!()
    }

    /// The timer fired. A cycle runs only when one is due: the delay is capped, and
    /// a run started elsewhere may have moved the due time. The chain re-arms
    /// whatever the run did, so no failure can leave the heartbeat silent for the
    /// life of the process. A stop clears the state, and the identity check then
    /// declines to arm a timer nothing owns.
    async fn on_timer(&self) {
        todo!()
    }

    /// One cycle happened. The in-memory deadline and the persisted one move
    /// together, so the next process arms the same one. A write that fails logs a
    /// warning and leaves the persisted deadline behind, which reads as overdue on
    /// the next boot, so a check runs early.
    async fn record_cycle(&self, state: &StateHandle) {
        todo!()
    }

    /// A run ended: the next check is an interval away, and the trigger messages it
    /// read are answered. Called after the delivery, so a restart before it runs
    /// the check again rather than losing its alert.
    async fn end_cycle(&self, state: &StateHandle, read: &ReadMessages) {
        todo!()
    }

    /// Kept as pending work from before the model call until the run ends, so the
    /// attempt bound gives up a run that stops the process on every boot.
    async fn begin_run(&self, state: &StateHandle, read: &ReadMessages) {
        todo!()
    }

    /// The run ended: the messages it read are answered.
    async fn end_run(&self, state: &StateHandle, read: &ReadMessages) {
        todo!()
    }

    /// Persist a deadline no run produced, so a cadence change survives a restart.
    /// Fire-and-forget: the caller is `start_heartbeat`, which a boot and a
    /// management route both call and neither waits on a write for.
    fn persist_schedule(&self, state: &StateHandle) {
        todo!()
    }

    /// The one write of the schedule columns. `ran_at` moves the last-run column
    /// too, and only a cycle passes it, so a cadence change reports no heartbeat.
    async fn write_schedule(&self, state: &StateHandle, ran_at: Option<DateTime<Utc>>) {
        todo!()
    }

    /// Stop the heartbeat: persist STOPPED, emit `heartbeat stopped` when one was
    /// running, and clear the timer.
    pub fn stop_heartbeat(&self) {
        todo!()
    }

    fn clear_heartbeat_timer(&self) {
        todo!()
    }

    /// Run one heartbeat check now, with every channel's pending trigger messages.
    /// Every failure is answered in the result, never returned.
    pub async fn execute_heartbeat(&self) -> HeartbeatResult {
        todo!()
    }

    // ========================================================================
    // Channel-Triggered Heartbeat
    // ========================================================================

    /// Notify that `source` has new messages queued in the DB.
    /// Fires a heartbeat if not already running. If already running, the
    /// messages stay queued for the next run.
    pub fn trigger_from(&self, source: &Arc<dyn HeartbeatTriggerSource>) -> TriggerOutcome {
        todo!()
    }

    /// Execute a single channel-triggered heartbeat over the pending messages, and
    /// remove them once it ends. Messages that arrive during execution wait for the
    /// next run.
    async fn execute_channel_triggered_heartbeat(&self, source: Arc<dyn HeartbeatTriggerSource>) {
        todo!()
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
        todo!()
    }

    fn log_steps(&self, response_text: &str, steps: &[InvokeStep], label: Option<&str>) {
        todo!()
    }

    fn build_heartbeat_prompt(&self) -> String {
        HEARTBEAT_PROMPT.to_string()
    }

    fn build_triggered_heartbeat_prompt(&self, triggers: &[HeartbeatTrigger]) -> String {
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
        todo!()
    }

    /// A run's sends join the record, each replacing the older send to its place.
    fn note_sends(&self, state: &StateHandle, tool_calls: &[ToolCallRecord], checks: &str) {
        todo!()
    }

    /// The Heartbeat document this run checks, and where it may post, once the
    /// restore is done. A record made under other checks is dropped.
    async fn read_checks(&self, state: &StateHandle) -> anyhow::Result<(String, DeliveryTarget)> {
        todo!()
    }

    /// The record as the prompt reads it: each send with its age.
    fn send_record_for_prompt(&self, state: &StateHandle) -> Option<TaskLastSend> {
        todo!()
    }

    /// A message a run sent before a shutdown stopped it stays in history, so the
    /// restored record has it. The unfinished text is no report. Answers whether the run sent.
    async fn keep_stopped_run(
        &self,
        state: &StateHandle,
        invoke_result: &InvokeResponse,
    ) -> anyhow::Result<bool> {
        todo!()
    }

    /// A run's result, so the next run reads whether a finding still held. An empty result says nothing.
    fn note_report(&self, state: &StateHandle, text: &str) {
        todo!()
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
        todo!()
    }

    pub async fn trigger_heartbeat(&self) -> HeartbeatResult {
        self.execute_heartbeat().await
    }
}

impl Default for HeartbeatService {
    fn default() -> Self {
        Self::new()
    }
}

pub static HEARTBEAT_SERVICE: LazyLock<HeartbeatService> = LazyLock::new(HeartbeatService::new);
