//! Cron Scheduler Service (Agent-Runtime)
//!
//! Manages user-scheduled tasks using cron expressions.
//! Invokes the LLM directly (in-process).
//!
//! Supports three schedule types:
//! - "at" / "in" — one-shot: "in 20 minutes", "at 3pm"
//! - "every" — interval: "every 2 hours"
//! - cron expression: "0 9 * * *" (9am daily)
//!
//! A task's `nextRunAt` moves past a run only when that run completes, so a run
//! a restart interrupted, or a tick that fell while the runtime was down, is
//! still due at the next boot, which runs it once.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use chrono::{DateTime, Utc};
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

use crate::db::models::CronTask;
use crate::services::delivery_target_service::DeliverTo;
use crate::services::pending_work_service::PendingWorkItem;
use crate::types::{TaskLastSend, ToolCallRecord};

// ============================================================================
// Types
// ============================================================================

/// A task in the scheduler's shape: the stored row, its dates as ISO strings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendCronTask {
    pub id: String,
    pub agent_id: String,
    pub user_id: String,
    pub name: String,
    pub schedule: String,
    pub instruction: String,
    pub is_active: bool,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    /// When set, the task "continues" the originating conversation in this thread
    /// instead of broadcasting to the user's latest thread. `origin_channel`/
    /// `origin_channel_id` drive channel-neutral scoped delivery (see `execute_task`).
    pub thread_id: Option<String>,
    pub origin_channel: Option<String>,
    pub origin_channel_id: Option<String>,
    /// Where an unbound task delivers: `DELIVER_TARGETS`, and the chosen channels, comma-separated.
    pub deliver_to: String,
    pub channel_ids: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A stored task in the scheduler's shape, its dates as ISO strings.
pub fn to_backend_cron_task(row: &CronTask) -> BackendCronTask {
    use crate::support::iso;
    BackendCronTask {
        id: row.id.clone(),
        agent_id: row.agent_id.clone(),
        user_id: row.user_id.clone(),
        name: row.name.clone(),
        schedule: row.schedule.clone(),
        instruction: row.instruction.clone(),
        is_active: row.is_active,
        last_run_at: row.last_run_at.as_ref().map(iso),
        next_run_at: row.next_run_at.as_ref().map(iso),
        thread_id: row.thread_id.clone(),
        origin_channel: row.origin_channel.clone(),
        origin_channel_id: row.origin_channel_id.clone(),
        deliver_to: row.deliver_to.clone(),
        channel_ids: row.channel_ids.clone(),
        created_at: iso(&row.created_at),
        updated_at: iso(&row.updated_at),
    }
}

/// The fields an edit may change. A field left `None` keeps its value.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CronTaskChanges {
    pub name: Option<String>,
    pub schedule: Option<String>,
    pub instruction: Option<String>,
    pub deliver_to: Option<String>,
    /// The linked channels of the target's channel to post to; `Some(None)` or
    /// empty = its default destination.
    pub channel_ids: Option<Option<Vec<String>>>,
}

/// A task field an edit can be refused over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CronTaskField {
    Name,
    Schedule,
    DeliverTo,
    ChannelIds,
}

impl CronTaskField {
    pub fn as_str(self) -> &'static str {
        match self {
            CronTaskField::Name => "name",
            CronTaskField::Schedule => "schedule",
            CronTaskField::DeliverTo => "deliverTo",
            CronTaskField::ChannelIds => "channelIds",
        }
    }
}

/// What an edit did.
#[derive(Debug, Clone)]
pub enum CronTaskEdit {
    Updated { task: CronTask },
    NotFound { error: String },
    Running { error: String },
    Invalid { field: CronTaskField, error: String },
}

/// The delivery fields of a task write.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskDeliveryChanges {
    pub deliver_to: Option<String>,
    pub channel_ids: Option<Option<Vec<String>>>,
}

/// A task's stored delivery, and the conversation it continues, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentTaskDelivery {
    pub deliver_to: String,
    pub channel_ids: Option<String>,
    pub thread_id: Option<String>,
}

/// What a task write stores for its delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskDeliveryValue {
    pub deliver_to: DeliverTo,
    pub channel_ids: Option<String>,
}

/// A refused task delivery: the field (`DeliverTo` or `ChannelIds`) and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskDeliveryRefusal {
    pub field: CronTaskField,
    pub error: String,
}

/// What a task write stores for its delivery, or why it is refused.
pub type TaskDelivery = Result<TaskDeliveryValue, TaskDeliveryRefusal>;

/// Read the delivery a task write stores. A write that leaves the target out keeps
/// the current one, and a new target drops the chosen channels the write does not
/// restate. A task that continues a conversation answers there, so it takes no
/// other target.
pub async fn read_task_delivery(
    changes: &TaskDeliveryChanges,
    agent_id: &str,
    current: &CurrentTaskDelivery,
) -> anyhow::Result<TaskDelivery> {
    todo!()
}

/// Who started a schedule change, which decides its telemetry event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScheduleSource {
    /// `cron task scheduled`.
    Create,
    /// `cron task updated`.
    Update,
    /// No event.
    Boot,
}

/// Options of `schedule_task`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScheduleTaskOptions {
    /// Default `Create`.
    pub source: Option<ScheduleSource>,
    /// The mode of the agent run that made the change.
    pub invoke_mode: Option<String>,
}

/// The user and agent an edit is limited to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskOwner {
    pub user_id: String,
    pub agent_id: String,
}

/// Options of `update_task`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateTaskOptions {
    pub owner: Option<TaskOwner>,
    pub invoke_mode: Option<String>,
}

/// The running job of a scheduled task: a cron job for a recurring schedule, or
/// the timer of a one-shot.
pub struct JobHandle {
    pub stop: Box<dyn Fn() + Send + Sync>,
    /// When a recurring job next fires; `None` for a one-shot's timer.
    pub get_next_run: Option<Box<dyn Fn() -> Option<DateTime<Utc>> + Send + Sync>>,
}

struct ScheduledJob {
    task: BackendCronTask,
    job: JobHandle,
    is_one_shot: bool,
}

/// What a task's last sending run sent and what the newest run after it reported,
/// with the instruction it was recorded under.
#[derive(Debug, Clone)]
struct LastSendEntry {
    instruction: String,
    record: TaskLastSend,
}

/// How far back the boot looks for a tick of a task that has no stored next run.
const MISSED_TICK_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// How many stored runs of a task a restart reads to find its last send: a week
/// of hourly runs that each delivered a result. The read is once per task per
/// process, and three columns per row.
const LAST_SEND_ROWS: i64 = 200;

/// A recurring task missed a run when its last run was interrupted, or its tick
/// fell while the runtime was down: its stored next run has passed. A task stored
/// before next runs were stored has none. It missed a run when a tick of its
/// schedule fell after its last run, within the last day, which covers the
/// downtime of the upgrade that added the column. A six-field expression names
/// the second, a five-field one the minute; `matches` answers whether a tick
/// falls at an instant.
fn missed_run(task: &BackendCronTask, matches: &dyn Fn(DateTime<Utc>) -> bool) -> bool {
    todo!()
}

/// Whether the risk gate refused one of a run's tool calls. `invoke` records a
/// refusal as a failed call whose output is the refusal's summary with its code;
/// any other failed call has no output. Fails when such an output is not JSON.
fn has_risk_blocked_call(tool_calls: &[ToolCallRecord]) -> anyhow::Result<bool> {
    todo!()
}

// ============================================================================
// Cron Scheduler Service
// ============================================================================

pub struct CronSchedulerService {
    scheduled_jobs: Mutex<IndexMap<String, Arc<ScheduledJob>>>,
    /// The zone every recurring schedule is read in: the agent's setting, set at boot and on change.
    zone: RwLock<String>,
    /// Per unbound task, what its last sending run sent and what the newest run
    /// after it reported, which the next run reads in place of history, with the
    /// instruction it was recorded under. `None` means none; an absent entry is read
    /// from the stored messages on the first run.
    last_send: Mutex<HashMap<String, Option<LastSendEntry>>>,
    /// Tasks with a run currently in flight, each with the run. A cron job fires ticks
    /// regardless of whether the previous run finished, so a run outlasting its interval
    /// would otherwise overlap itself — double-delivering and racing the delivery
    /// baseline. An overlapping tick is skipped, not queued.
    running_tasks: Mutex<HashMap<String, Shared<BoxFuture<'static, bool>>>>,
    /// Tasks whose runs stopped the process on `MAX_RESUME_ATTEMPTS` boots in a row. The boot runs them no more.
    given_up: Mutex<HashSet<String>>,
    /// One-shots that have started. Each runs, then deletes its row, so an edit is refused.
    fired_one_shots: Mutex<HashSet<String>>,
    /// Per task, the edit or one-shot start in progress. An edit reads, writes and re-registers
    /// the task, and a one-shot starts only on the job it was armed with, so neither sees the
    /// other halfway.
    task_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl CronSchedulerService {
    pub fn new() -> Self {
        Self {
            scheduled_jobs: Mutex::new(IndexMap::new()),
            zone: RwLock::new("UTC".to_string()),
            last_send: Mutex::new(HashMap::new()),
            running_tasks: Mutex::new(HashMap::new()),
            given_up: Mutex::new(HashSet::new()),
            fired_one_shots: Mutex::new(HashSet::new()),
            task_locks: Mutex::new(HashMap::new()),
        }
    }

    /// Whether any cron task run is currently in flight.
    pub fn has_running_task(&self) -> bool {
        !self.running_tasks.lock().is_empty()
    }

    /// List active cron tasks from the database.
    /// Called during startup to initialize the scheduler.
    /// If `agent_id` is provided, limits the result to that agent so the
    /// container's scheduler doesn't pick up other agents' tasks.
    pub async fn list_active_cron_tasks(
        &self,
        agent_id: Option<&str>,
    ) -> anyhow::Result<Vec<BackendCronTask>> {
        todo!()
    }

    /// The zone every recurring schedule is read in, as an IANA name.
    pub fn timezone(&self) -> String {
        self.zone.read().clone()
    }

    /// Read every recurring schedule in this zone from now on. A running job is replaced, so its
    /// next tick moves with the zone; the task's instruction is unchanged, so its delivery
    /// baseline stays. A name that is not a zone is logged
    /// (`[CronScheduler] Unknown time zone "<zone>"; recurring tasks run in UTC`) and UTC
    /// is used instead.
    pub fn use_timezone(&self, timezone: &str) {
        todo!()
    }

    /// Run `f` after every edit or one-shot start of the task that came before it.
    async fn with_task_lock<T>(&self, task_id: &str, f: impl Future<Output = T>) -> T {
        todo!()
    }

    /// The boot step for runs a restart stopped. A run that is still due runs again
    /// when its task is scheduled. A run the attempt bound gave up does not.
    pub async fn resume(
        &self,
        items: Vec<PendingWorkItem>,
        given_up: Vec<PendingWorkItem>,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Whether the boot gives up `task`'s missed run, logging it when it does.
    fn gives_up(&self, task: &BackendCronTask) -> bool {
        todo!()
    }

    /// Start the cron job for a recurring task in the current zone and hold it,
    /// and store when it next runs. A run in flight stores that itself when it ends.
    /// At boot, a task that missed a run runs once now, before its next run is stored.
    fn register_recurring(&self, task: BackendCronTask, at_boot: bool) {
        todo!()
    }

    /// Schedule a task, replacing any job it already has. `source` decides the telemetry event:
    /// `cron task scheduled` for a new task, `cron task updated` for an edit, none for `Boot`.
    /// The scheduler owns both events. `invoke_mode` is the mode of the agent run that made the
    /// change. A task keeps its delivery baseline while its instruction and its target are the same.
    pub fn schedule_task(&self, task: BackendCronTask, opts: ScheduleTaskOptions) {
        todo!()
    }

    /// Arm the timer of a one-shot and hold it. A past-due one runs at once. `after_restart` tells
    /// the model that a run of the task may have stopped part-way at a restart.
    fn register_one_shot(&self, task: BackendCronTask, delay_ms: i64, after_restart: bool) {
        todo!()
    }

    /// Run a one-shot, then delete it. A run of the task's earlier schedule ends first. An edit or a
    /// delete that replaced or removed this job before the start leaves this one nothing to do. One a
    /// shutdown interrupts stays, and the next boot runs it.
    async fn run_one_shot(&self, scheduled: Arc<ScheduledJob>, after_restart: bool) {
        todo!()
    }

    /// Edit a stored task and re-register it. Values are trimmed, and a schedule is read again from
    /// now. `owner` limits the edit to that user's and agent's tasks, and `invoke_mode` is as for
    /// `schedule_task`. An edit that changes nothing writes nothing.
    pub async fn update_task(
        &self,
        task_id: &str,
        changes: CronTaskChanges,
        opts: UpdateTaskOptions,
    ) -> anyhow::Result<CronTaskEdit> {
        todo!()
    }

    /// Remove the job of a deleted task. The scheduler owns the `cron task deleted` event, and
    /// `invoke_mode` is as for `schedule_task`.
    pub fn unschedule_task(&self, task_id: &str, user_id: Option<&str>, invoke_mode: Option<&str>) {
        todo!()
    }

    /// When a task next runs: the stored time of a one-shot, else what its running cron job
    /// reports. `None` for a task this process has not scheduled, such as a paused one.
    pub fn next_run_for(&self, task_id: &str) -> Option<DateTime<Utc>> {
        let scheduled = self.scheduled_jobs.lock().get(task_id).cloned()?;
        if scheduled.is_one_shot {
            return scheduled
                .task
                .next_run_at
                .as_deref()
                .and_then(crate::support::parse_iso);
        }
        scheduled.job.get_next_run.as_ref().and_then(|next| next())
    }

    /// Stop and drop the in-memory job, with no telemetry side effects.
    fn stop_job(&self, task_id: &str) {
        let removed = self.scheduled_jobs.lock().shift_remove(task_id);
        if let Some(scheduled) = removed {
            (scheduled.job.stop)();
        }
    }

    /// What the task's runs sent and reported since. Read from the stored messages
    /// once per process; a failed read is tried again on the next run.
    async fn last_send_of(&self, task: &BackendCronTask) -> Option<TaskLastSend> {
        todo!()
    }

    /// The newest stored run of this task that sent a message, and the newest one
    /// after it; `Ok(None)` when there is none, and `Err` when the read fails. An
    /// unbound run is stored in its user's thread under the task's heading, delivered
    /// or withheld, with its tool calls. The rows hold neither the task's id, its
    /// instruction nor a run's error, which costs these trades after a restart: a
    /// rename finds none, and two tasks of one name read each other's; a send made
    /// under an earlier instruction is read as this instruction's; a failed run can be
    /// read as the newest report; a run the gate withheld that sent nothing is not
    /// stored, so an all-clear after the send is lost; and a send older than the
    /// newest `LAST_SEND_ROWS` runs is lost. A failed read is logged
    /// (`[CronScheduler] Could not read what "<name>" last sent`).
    async fn read_last_send(&self, task: &BackendCronTask) -> anyhow::Result<Option<TaskLastSend>> {
        todo!()
    }

    /// A run that sent replaces the record, unless its task changed while it ran.
    /// Answers whether the run sent.
    fn note_sends(&self, task: &BackendCronTask, tool_calls: &[ToolCallRecord]) -> bool {
        todo!()
    }

    /// A later run's result, so the next run reads whether the finding still held. An empty result says nothing.
    fn note_report(&self, task: &BackendCronTask, body: &str) {
        todo!()
    }

    /// Whether the task is still scheduled with the instruction this run had.
    fn is_current(&self, task: &BackendCronTask) -> bool {
        self.scheduled_jobs
            .lock()
            .get(&task.id)
            .is_some_and(|scheduled| scheduled.task.instruction == task.instruction)
    }

    /// A run ended: store when, and when the task next runs. Without a run, stores
    /// the next run alone. A one-shot is deleted instead, so this is for a
    /// recurring task. A run can delete its own task, so the write accepts a
    /// missing row. A failed write is logged; the stored time then reads as due,
    /// and the next boot runs the task once more.
    async fn record_run(&self, task_id: &str, ran_at: Option<DateTime<Utc>>) {
        todo!()
    }

    async fn delete_cron_task(&self, task_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Run a task once. False when a shutdown stopped the run before it delivered,
    /// which leaves the run due. `after_restart` tells the model that a run of the
    /// task may have stopped part-way at a restart. An overlapping run is skipped
    /// (`[CronScheduler] "<name>" is still running — skipping overlapping run`) and
    /// answers true.
    async fn execute_task(&self, task: BackendCronTask, after_restart: bool) -> bool {
        todo!()
    }

    /// The body of one run: invoke, deliver per the task, record the outcome.
    async fn run_task(&self, task: BackendCronTask, after_restart: bool) -> bool {
        todo!()
    }

    pub fn stop_all(&self) {
        todo!()
    }
}

impl Default for CronSchedulerService {
    fn default() -> Self {
        Self::new()
    }
}

pub static CRON_SCHEDULER_SERVICE: LazyLock<CronSchedulerService> =
    LazyLock::new(CronSchedulerService::new);
