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
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use anyhow::anyhow;
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::task::AbortHandle;

use crate::config::CONFIG;
use crate::db::models::{CronTask, CronTaskChangeset, MessageRole, MessageTrigger};
use crate::db::schema::conversation_messages::dsl as m;
use crate::db::schema::conversation_threads::dsl as t;
use crate::db::schema::cron_tasks::dsl as ct;
use crate::db::sql_types::DbDateTime;
use crate::invoke::invoke;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::lib::timezone::{is_timezone, resolve_timezone};
use crate::lib::visible_text::visible_text;
use crate::prompts::scheduled_run_prompt::scheduled_run_prompt;
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::services::cron_schedule::{CronMatcher, ScheduleOptions, parse_schedule, validate_cron};
use crate::services::delivery_target_service::{
    DELIVER_TARGETS, DELIVERY_TARGET_SERVICE, DeliverTo, DeliveryTarget, TargetPublishOptions,
    TargetTrigger, is_valid_deliver_to_str, parse_comma_list,
};
use crate::services::inline_image_placement::place_reply_images;
use crate::services::message_delivery_service::{MESSAGE_DELIVERY_SERVICE, PublishOptions};
use crate::services::outbound_message_service::{
    OUTBOUND_MESSAGE_SERVICE, WITHHELD_RUN_TEXT, WithheldRun, sent_message_list, sent_messages,
};
use crate::services::pending_work_service::{
    MAX_RESUME_ATTEMPTS, PENDING_WORK_SERVICE, PendingWorkItem, PendingWorkKind,
};
use crate::support::{from_ms, iso, js, now_ms, parse_iso};
use crate::types::{
    InvokeErrorType, InvokeMode, InvokeRequest, TaskLastSend, TaskReport, ToolCallRecord,
};
use crate::{log_error, log_info, log_warn};

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
    let deliver_to = changes
        .deliver_to
        .clone()
        .unwrap_or_else(|| current.deliver_to.clone());
    if !is_valid_deliver_to_str(&deliver_to) {
        return Ok(Err(TaskDeliveryRefusal {
            field: CronTaskField::DeliverTo,
            error: format!("deliverTo must be one of: {}", DELIVER_TARGETS.join(", ")),
        }));
    }
    let mut channel_ids = if deliver_to == current.deliver_to {
        current.channel_ids.clone()
    } else {
        None
    };
    if let Some(raw) = &changes.channel_ids {
        let raw = match raw {
            Some(ids) => Value::Array(ids.iter().cloned().map(Value::String).collect()),
            None => Value::Null,
        };
        let read = DELIVERY_TARGET_SERVICE
            .read_channel_ids(
                &raw,
                &deliver_to,
                agent_id,
                &parse_comma_list(current.channel_ids.as_deref()),
            )
            .await?;
        match read {
            Ok(value) => channel_ids = value,
            Err(error) => {
                return Ok(Err(TaskDeliveryRefusal {
                    field: CronTaskField::ChannelIds,
                    error,
                }));
            }
        }
    }
    let continues = current
        .thread_id
        .as_deref()
        .is_some_and(|thread| !thread.is_empty());
    let chose_channels = channel_ids.as_deref().is_some_and(|ids| !ids.is_empty());
    if continues && (deliver_to != "all" || chose_channels) {
        return Ok(Err(TaskDeliveryRefusal {
            field: CronTaskField::DeliverTo,
            error: "This task continues a conversation, so it replies there".to_string(),
        }));
    }
    Ok(Ok(TaskDeliveryValue {
        deliver_to,
        channel_ids,
    }))
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
enum Job {
    Recurring {
        matcher: Arc<CronMatcher>,
        stopped: Arc<AtomicBool>,
        runner: AbortHandle,
    },
    OneShot {
        timer: Mutex<Option<AbortHandle>>,
    },
}

impl Job {
    fn stop(&self) {
        match self {
            Job::Recurring {
                stopped, runner, ..
            } => {
                stopped.store(true, Ordering::SeqCst);
                runner.abort();
            }
            Job::OneShot { timer } => {
                if let Some(timer) = timer.lock().take() {
                    timer.abort();
                }
            }
        }
    }

    /// When a running recurring job next fires; `None` once stopped, and for a
    /// one-shot's timer.
    fn next_run(&self) -> Option<DateTime<Utc>> {
        match self {
            Job::Recurring {
                matcher, stopped, ..
            } if !stopped.load(Ordering::SeqCst) => matcher.next_match(Utc::now()).ok(),
            _ => None,
        }
    }
}

struct ScheduledJob {
    task: BackendCronTask,
    job: Job,
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

/// How late a tick may run before it counts as missed.
const MISSED_EXECUTION_TOLERANCE_MS: i64 = 1000;

/// The longest one wait of a recurring job; a later tick is waited for in steps.
const MAX_TICK_DELAY_MS: i64 = 86_400_000;

/// A timer holds a 32-bit delay; a one-shot armed for longer fires at once, as
/// Node's `setTimeout` does.
const MAX_TIMER_DELAY_MS: i64 = 2_147_483_647;

/// A recurring task missed a run when its last run was interrupted, or its tick
/// fell while the runtime was down: its stored next run has passed. A task stored
/// before next runs were stored has none. It missed a run when a tick of its
/// schedule fell after its last run, within the last day, which covers the
/// downtime of the upgrade that added the column. A six-field expression names
/// the second, a five-field one the minute; `matches` answers whether a tick
/// falls at an instant.
fn missed_run(task: &BackendCronTask, matches: &dyn Fn(DateTime<Utc>) -> bool) -> bool {
    let now = now_ms();
    if let Some(next) = &task.next_run_at {
        return parse_iso(next).is_some_and(|next| next.timestamp_millis() <= now);
    }
    let last = task.last_run_at.as_deref().unwrap_or(&task.created_at);
    let since = parse_iso(last)
        .map(|at| at.timestamp_millis())
        .unwrap_or(i64::MIN)
        .max(now - MISSED_TICK_WINDOW_MS);
    // A six-field expression names the second, a five-field one the minute.
    let fields = js::trim(&task.schedule)
        .split(js::is_js_whitespace)
        .filter(|field| !field.is_empty())
        .count();
    let step = if fields == 6 { 1000 } else { 60_000 };
    let mut tick = now.div_euclid(step) * step;
    while tick > since {
        if matches(from_ms(tick)) {
            return true;
        }
        tick -= step;
    }
    false
}

/// Whether the risk gate refused one of a run's tool calls. `invoke` records a
/// refusal as a failed call whose output is the refusal's summary with its code;
/// any other failed call has no output. Fails when such an output is not JSON.
fn has_risk_blocked_call(tool_calls: &[ToolCallRecord]) -> anyhow::Result<bool> {
    for call in tool_calls {
        if call.success || call.output.is_empty() {
            continue;
        }
        let parsed: Value = serde_json::from_str(&call.output)?;
        if parsed.is_null() {
            return Err(anyhow!(
                "Cannot destructure property 'code' of 'JSON.parse(...)' as it is null."
            ));
        }
        let code = parsed.get("code").and_then(Value::as_str);
        if matches!(
            code,
            Some("TOOL_RISK_BLOCKED") | Some("TOOL_RISK_EVALUATION_UNAVAILABLE")
        ) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The current time with its milliseconds dropped.
fn now_without_ms() -> DateTime<Utc> {
    from_ms(now_ms().div_euclid(1000) * 1000)
}

/// What a recurring job does when its timer fires: the ticks it missed, the tick
/// to run, and the tick to wait for next.
struct Beat {
    missed: Vec<DateTime<Utc>>,
    run: Option<DateTime<Utc>>,
    next: DateTime<Utc>,
}

/// The ticks between the one a job waited for and now. A tick runs when it is
/// at most `tolerance_ms` late and the next one has not come; older ones are missed.
fn plan_beat(
    expected: DateTime<Utc>,
    now: DateTime<Utc>,
    tolerance_ms: i64,
    next_match: impl Fn(DateTime<Utc>) -> anyhow::Result<DateTime<Utc>>,
) -> anyhow::Result<Beat> {
    let mut missed = Vec::new();
    let mut slot = expected;
    loop {
        if now < slot {
            return Ok(Beat {
                missed,
                run: None,
                next: slot,
            });
        }
        let next = next_match(slot)?;
        if next <= slot {
            return Ok(Beat {
                missed,
                run: None,
                next: next_match(now)?,
            });
        }
        let gap = (next - slot).num_milliseconds();
        let late_by = (now - slot).num_milliseconds();
        if late_by <= tolerance_ms && late_by < gap {
            return Ok(Beat {
                missed,
                run: Some(slot),
                next,
            });
        }
        missed.push(slot);
        slot = next;
    }
}

/// The warning a missed tick writes to stderr.
fn warn_missed_execution(date: DateTime<Utc>) {
    let local = date.with_timezone(&chrono::Local);
    eprintln!(
        "[{}] [PID: {}] \x1b[32m[NODE-CRON]\x1b[32m \x1b[33m[WARN]\x1b[0m missed execution at {}! Possible blocking IO or high CPU user at the same process used by node-cron.",
        crate::support::now_iso(),
        std::process::id(),
        local.format("%a %b %d %Y %H:%M:%S GMT%z (%Z)")
    );
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

/// `Math.round`: halves round up.
fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// A `LIKE` pattern matching text that starts with `prefix`, with `\` escaping.
fn starts_with_pattern(prefix: &str) -> String {
    let mut pattern = String::with_capacity(prefix.len() + 1);
    for ch in prefix.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    pattern.push('%');
    pattern
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
        let agent_id = agent_id.map(str::to_string);
        let rows = crate::db::run(move |conn| {
            let mut query = ct::cron_tasks
                .filter(ct::is_active.eq(true))
                .select(CronTask::as_select())
                .into_boxed();
            if let Some(agent_id) = agent_id {
                query = query.filter(ct::agent_id.eq(agent_id));
            }
            Ok(query.load(conn)?)
        })
        .await?;
        Ok(rows.iter().map(to_backend_cron_task).collect())
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
    pub fn use_timezone(&'static self, timezone: &str) {
        let accepted = is_timezone(timezone);
        if !accepted {
            log_error!(
                "[CronScheduler] Unknown time zone \"{}\"; recurring tasks run in UTC",
                timezone
            );
        }
        *self.zone.write() = if accepted {
            timezone.to_string()
        } else {
            "UTC".to_string()
        };
        let jobs: Vec<Arc<ScheduledJob>> = self.scheduled_jobs.lock().values().cloned().collect();
        for scheduled in jobs {
            if scheduled.is_one_shot {
                continue;
            }
            scheduled.job.stop();
            self.register_recurring_logged(scheduled.task.clone(), false);
        }
    }

    /// Run `f` after every edit or one-shot start of the task that came before it.
    async fn with_task_lock<T>(&self, task_id: &str, f: impl Future<Output = T>) -> T {
        let lock = Arc::clone(
            self.task_locks
                .lock()
                .entry(task_id.to_string())
                .or_default(),
        );
        let result = {
            let _turn = lock.lock().await;
            f.await
        };
        let mut locks = self.task_locks.lock();
        if locks
            .get(task_id)
            .is_some_and(|current| Arc::ptr_eq(current, &lock) && Arc::strong_count(current) == 2)
        {
            locks.remove(task_id);
        }
        result
    }

    /// The boot step for runs a restart stopped. A run that is still due runs again
    /// when its task is scheduled. A run the attempt bound gave up does not.
    pub async fn resume(
        &self,
        _items: Vec<PendingWorkItem>,
        given_up: Vec<PendingWorkItem>,
    ) -> anyhow::Result<()> {
        let mut set = self.given_up.lock();
        for item in given_up {
            set.insert(item.key);
        }
        Ok(())
    }

    /// Whether the boot gives up `task`'s missed run, logging it when it does.
    fn gives_up(&self, task: &BackendCronTask) -> bool {
        if !self.given_up.lock().remove(&task.id) {
            return false;
        }
        log_warn!(
            "[CronScheduler] \"{}\" stopped the runtime on {} boots in a row - skipping its missed run",
            task.name,
            MAX_RESUME_ATTEMPTS
        );
        true
    }

    /// Start the cron job for a recurring task and run it until it is stopped:
    /// each tick that comes on time runs the task. Fails when the expression has no
    /// tick within a hundred years.
    fn start_recurring(
        &'static self,
        task: BackendCronTask,
        matcher: Arc<CronMatcher>,
    ) -> anyhow::Result<Job> {
        let mut expected = matcher.next_match(now_without_ms())?;
        let stopped = Arc::new(AtomicBool::new(false));
        let ticks = Arc::clone(&matcher);
        let runner = tokio::spawn(async move {
            loop {
                let delay = (expected.timestamp_millis() - now_ms()).clamp(0, MAX_TICK_DELAY_MS);
                tokio::time::sleep(Duration::from_millis(delay as u64)).await;
                let beat = match plan_beat(
                    expected,
                    now_without_ms(),
                    MISSED_EXECUTION_TOLERANCE_MS,
                    |date| ticks.next_match(date),
                ) {
                    Ok(beat) => beat,
                    Err(err) => {
                        log_error!(
                            json!({ "err": err_json(&err) }),
                            "[CronScheduler] \"{}\" has no next run",
                            task.name
                        );
                        return;
                    }
                };
                expected = beat.next;
                for missed in beat.missed {
                    warn_missed_execution(missed);
                }
                if beat.run.is_some() {
                    let task = task.clone();
                    tokio::spawn(async move {
                        self.execute_task(task, false).await;
                    });
                }
            }
        });
        Ok(Job::Recurring {
            matcher,
            stopped,
            runner: runner.abort_handle(),
        })
    }

    /// Start the cron job for a recurring task in the current zone and hold it,
    /// and store when it next runs. A run in flight stores that itself when it ends.
    /// At boot, a task that missed a run runs once now, before its next run is stored.
    fn register_recurring(
        &'static self,
        task: BackendCronTask,
        at_boot: bool,
    ) -> anyhow::Result<()> {
        let zone = resolve_timezone(&self.timezone()).unwrap_or(chrono_tz::Tz::UTC);
        let matcher = Arc::new(CronMatcher::new(&task.schedule, zone)?);
        let job = self.start_recurring(task.clone(), Arc::clone(&matcher))?;
        self.scheduled_jobs.lock().insert(
            task.id.clone(),
            Arc::new(ScheduledJob {
                task: task.clone(),
                job,
                is_one_shot: false,
            }),
        );
        if at_boot && missed_run(&task, &|date| matcher.matches(date)) && !self.gives_up(&task) {
            log_info!(
                "[CronScheduler] Recurring \"{}\" missed a run - executing now",
                task.name
            );
            let missed = task.clone();
            tokio::spawn(async move {
                self.execute_task(missed, true).await;
            });
        }
        if !self.running_tasks.lock().contains_key(&task.id) {
            let task_id = task.id.clone();
            tokio::spawn(async move { self.record_run(&task_id, None).await });
        }
        Ok(())
    }

    /// `register_recurring`, logging the schedule that has no tick to run.
    fn register_recurring_logged(&'static self, task: BackendCronTask, at_boot: bool) -> bool {
        let name = task.name.clone();
        match self.register_recurring(task, at_boot) {
            Ok(()) => true,
            Err(err) => {
                log_error!(
                    json!({ "err": err_json(&err) }),
                    "[CronScheduler] Could not schedule \"{}\"",
                    name
                );
                false
            }
        }
    }

    /// Schedule a task, replacing any job it already has. `source` decides the telemetry event:
    /// `cron task scheduled` for a new task, `cron task updated` for an edit, none for `Boot`.
    /// The scheduler owns both events. `invoke_mode` is the mode of the agent run that made the
    /// change. A task keeps its delivery baseline while its instruction and its target are the same.
    pub fn schedule_task(&'static self, task: BackendCronTask, opts: ScheduleTaskOptions) {
        if task.user_id.is_empty() {
            log_error!(
                "[CronScheduler] Refusing to schedule \"{}\" — missing userId",
                task.name
            );
            return;
        }

        self.stop_job(&task.id);

        if !task.is_active {
            return;
        }

        let is_one_shot = task.next_run_at.is_some() && !validate_cron(&task.schedule);
        let source = opts.source.unwrap_or(ScheduleSource::Create);

        if source != ScheduleSource::Boot {
            let event = if source == ScheduleSource::Update {
                "cron task updated"
            } else {
                "cron task scheduled"
            };
            let mut props = IndexMap::new();
            props.insert("agent.id".to_string(), task.agent_id.clone());
            props.insert("cron.task.id".to_string(), task.id.clone());
            props.insert("cron.schedule".to_string(), task.schedule.clone());
            props.insert("cron.one_shot".to_string(), is_one_shot.to_string());
            props.insert(
                "cron.continue_in_thread".to_string(),
                task.thread_id
                    .as_deref()
                    .is_some_and(|thread| !thread.is_empty())
                    .to_string(),
            );
            props.insert("cron.deliver_to".to_string(), task.deliver_to.clone());
            if let Some(mode) = opts.invoke_mode.as_ref().filter(|mode| !mode.is_empty()) {
                props.insert("invoke.mode".to_string(), mode.clone());
            }
            track_event(event, Some(&task.user_id), Some(props));
        }

        if is_one_shot {
            let next_run_at = task
                .next_run_at
                .as_deref()
                .and_then(parse_iso)
                .map(|at| at.timestamp_millis())
                .unwrap_or(0);
            let delay = next_run_at - now_ms();
            let at_boot = source == ScheduleSource::Boot;
            if delay <= 0 && at_boot && self.gives_up(&task) {
                let task_id = task.id.clone();
                tokio::spawn(async move {
                    if let Err(err) = self.delete_cron_task(&task_id).await {
                        log_error!(
                            json!({ "err": err_json(&err) }),
                            "[CronScheduler] Failed to delete one-shot task {}",
                            task_id
                        );
                    }
                });
                return;
            }
            // A one-shot due at boot may have been running when the runtime stopped.
            let name = task.name.clone();
            self.register_one_shot(task, delay, at_boot && delay <= 0);
            if delay > 0 {
                log_info!(
                    "[CronScheduler] Scheduled one-shot \"{}\" in {}s",
                    name,
                    js_round(delay as f64 / 1000.0)
                );
            } else {
                log_info!(
                    "[CronScheduler] One-shot \"{}\" was past due - executing now",
                    name
                );
            }
        } else {
            if !validate_cron(&task.schedule) {
                log_error!(
                    "[CronScheduler] Invalid cron expression for \"{}\": {}",
                    task.name,
                    task.schedule
                );
                return;
            }

            let (name, schedule) = (task.name.clone(), task.schedule.clone());
            if self.register_recurring_logged(task, source == ScheduleSource::Boot) {
                log_info!(
                    "[CronScheduler] Scheduled recurring \"{}\": {}",
                    name,
                    schedule
                );
            }
        }
    }

    /// Arm the timer of a one-shot and hold it. A past-due one runs at once. `after_restart` tells
    /// the model that a run of the task may have stopped part-way at a restart.
    fn register_one_shot(&'static self, task: BackendCronTask, delay_ms: i64, after_restart: bool) {
        let task_id = task.id.clone();
        let scheduled = Arc::new(ScheduledJob {
            task,
            job: Job::OneShot {
                timer: Mutex::new(None),
            },
            is_one_shot: true,
        });
        // Node's timer fires a delay past its 32-bit range at once.
        let delay = if delay_ms > MAX_TIMER_DELAY_MS {
            1
        } else {
            delay_ms.max(0)
        };
        let armed = Arc::clone(&scheduled);
        let timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay as u64)).await;
            tokio::spawn(self.run_one_shot(armed, after_restart));
        });
        if let Job::OneShot { timer: slot } = &scheduled.job {
            *slot.lock() = Some(timer.abort_handle());
        }
        self.scheduled_jobs.lock().insert(task_id, scheduled);
    }

    /// Run a one-shot, then delete it. A run of the task's earlier schedule ends first. An edit or a
    /// delete that replaced or removed this job before the start leaves this one nothing to do. One a
    /// shutdown interrupts stays, and the next boot runs it.
    async fn run_one_shot(&'static self, scheduled: Arc<ScheduledJob>, after_restart: bool) {
        let task = scheduled.task.clone();
        let earlier = self.running_tasks.lock().get(&task.id).cloned();
        if let Some(earlier) = earlier {
            earlier.await;
        }
        let started = self
            .with_task_lock(&task.id, async {
                let mut jobs = self.scheduled_jobs.lock();
                if !jobs
                    .get(&task.id)
                    .is_some_and(|current| Arc::ptr_eq(current, &scheduled))
                {
                    return false;
                }
                jobs.shift_remove(&task.id);
                self.fired_one_shots.lock().insert(task.id.clone());
                true
            })
            .await;
        if !started {
            return;
        }

        if self.execute_task(task.clone(), after_restart).await
            && let Err(err) = self.delete_cron_task(&task.id).await
        {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[CronScheduler] Failed to delete one-shot task {}",
                task.id
            );
        }
        self.fired_one_shots.lock().remove(&task.id);
        self.last_send.lock().remove(&task.id);
    }

    /// Edit a stored task and re-register it. Values are trimmed, and a schedule is read again from
    /// now. `owner` limits the edit to that user's and agent's tasks, and `invoke_mode` is as for
    /// `schedule_task`. An edit that changes nothing writes nothing.
    pub async fn update_task(
        &'static self,
        task_id: &str,
        changes: CronTaskChanges,
        opts: UpdateTaskOptions,
    ) -> anyhow::Result<CronTaskEdit> {
        let name = changes
            .name
            .as_deref()
            .map(|name| js::trim(name).to_string());
        let schedule = changes
            .schedule
            .as_deref()
            .map(|schedule| js::trim(schedule).to_string());
        let instruction = changes
            .instruction
            .as_deref()
            .map(|instruction| js::trim(instruction).to_string());
        if name.as_deref() == Some("") {
            return Ok(CronTaskEdit::Invalid {
                field: CronTaskField::Name,
                error: "Name is required".to_string(),
            });
        }
        if schedule.as_deref() == Some("") {
            return Ok(CronTaskEdit::Invalid {
                field: CronTaskField::Schedule,
                error: "Schedule is required".to_string(),
            });
        }

        self.with_task_lock(task_id, async {
            let id = task_id.to_string();
            let owner = opts.owner.clone();
            let task = crate::db::run(move |conn| {
                let mut query = ct::cron_tasks
                    .filter(ct::id.eq(id))
                    .select(CronTask::as_select())
                    .into_boxed();
                if let Some(owner) = owner {
                    query = query
                        .filter(ct::user_id.eq(owner.user_id))
                        .filter(ct::agent_id.eq(owner.agent_id));
                }
                Ok(query.first(conn).optional()?)
            })
            .await?;
            let Some(task) = task else {
                return Ok(CronTaskEdit::NotFound {
                    error: "Cron task not found".to_string(),
                });
            };
            if self.fired_one_shots.lock().contains(task_id) {
                return Ok(CronTaskEdit::Running {
                    error: "This task is running now, and it is removed when the run ends"
                        .to_string(),
                });
            }

            let mut timing = (task.schedule.clone(), task.next_run_at);
            if let Some(schedule) = &schedule {
                let parsed = parse_schedule(
                    schedule,
                    ScheduleOptions {
                        timezone: Some(self.timezone()),
                        now: None,
                    },
                )?;
                if !parsed.is_one_shot && !validate_cron(&parsed.cron_expression) {
                    return Ok(CronTaskEdit::Invalid {
                        field: CronTaskField::Schedule,
                        error: format!("Invalid cron expression: {}", parsed.cron_expression),
                    });
                }
                // As in `schedule_task`, only a one-off task continues a conversation.
                if !parsed.is_one_shot
                    && task.thread_id.as_deref().is_some_and(|thread| !thread.is_empty())
                {
                    return Ok(CronTaskEdit::Invalid {
                        field: CronTaskField::Schedule,
                        error: "This task continues a conversation, so it can only run once, such as \"in 10 minutes\"".to_string(),
                    });
                }
                timing = (parsed.cron_expression, parsed.next_run_at);
            }

            let delivery = read_task_delivery(
                &TaskDeliveryChanges {
                    deliver_to: changes.deliver_to.clone(),
                    channel_ids: changes.channel_ids.clone(),
                },
                &task.agent_id,
                &CurrentTaskDelivery {
                    deliver_to: task.deliver_to.clone(),
                    channel_ids: task.channel_ids.clone(),
                    thread_id: task.thread_id.clone(),
                },
            )
            .await?;
            let delivery = match delivery {
                Ok(delivery) => delivery,
                Err(refusal) => {
                    return Ok(CronTaskEdit::Invalid {
                        field: refusal.field,
                        error: refusal.error,
                    });
                }
            };

            let new_name = name.clone().unwrap_or_else(|| task.name.clone());
            let new_instruction = instruction
                .clone()
                .unwrap_or_else(|| task.instruction.clone());
            let unchanged = new_name == task.name
                && new_instruction == task.instruction
                && timing.0 == task.schedule
                && timing.1.map(|at| at.timestamp_millis())
                    == task.next_run_at.map(|at| at.timestamp_millis())
                && delivery.deliver_to == task.deliver_to
                && delivery.channel_ids == task.channel_ids;
            if unchanged {
                return Ok(CronTaskEdit::Updated { task });
            }

            let id = task_id.to_string();
            let changes = CronTaskChangeset {
                name: Some(new_name),
                instruction: Some(new_instruction.clone()),
                schedule: Some(timing.0),
                next_run_at: Some(timing.1),
                deliver_to: Some(delivery.deliver_to),
                channel_ids: Some(delivery.channel_ids),
                ..CronTaskChangeset::default()
            };
            let updated = crate::db::run(move |conn| {
                let count = diesel::update(ct::cron_tasks.filter(ct::id.eq(&id)))
                    .set(&changes)
                    .execute(conn)?;
                if count == 0 {
                    return Ok(None);
                }
                Ok(Some(
                    ct::cron_tasks
                        .filter(ct::id.eq(&id))
                        .select(CronTask::as_select())
                        .first(conn)?,
                ))
            })
            .await?;
            let Some(updated) = updated else {
                return Ok(CronTaskEdit::NotFound {
                    error: "Cron task not found".to_string(),
                });
            };

            // A new instruction starts with no send record, so no run reads the old one's sends from
            // storage, whether the task has a job now or runs again later.
            if new_instruction != task.instruction {
                self.last_send.lock().insert(task_id.to_string(), None);
            }
            self.schedule_task(
                to_backend_cron_task(&updated),
                ScheduleTaskOptions {
                    source: Some(ScheduleSource::Update),
                    invoke_mode: opts.invoke_mode.clone(),
                },
            );
            Ok(CronTaskEdit::Updated { task: updated })
        })
        .await
    }

    /// Remove the job of a deleted task. The scheduler owns the `cron task deleted` event, and
    /// `invoke_mode` is as for `schedule_task`.
    pub fn unschedule_task(&self, task_id: &str, user_id: Option<&str>, invoke_mode: Option<&str>) {
        self.stop_job(task_id);
        self.last_send.lock().remove(task_id);
        let mut props = IndexMap::new();
        if let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) {
            props.insert("agent.id".to_string(), agent_id);
        }
        props.insert("cron.task.id".to_string(), task_id.to_string());
        if let Some(mode) = invoke_mode.filter(|mode| !mode.is_empty()) {
            props.insert("invoke.mode".to_string(), mode.to_string());
        }
        track_event("cron task deleted", user_id, Some(props));
    }

    /// When a task next runs: the stored time of a one-shot, else what its running cron job
    /// reports. `None` for a task this process has not scheduled, such as a paused one.
    pub fn next_run_for(&self, task_id: &str) -> Option<DateTime<Utc>> {
        let scheduled = self.scheduled_jobs.lock().get(task_id).cloned()?;
        if scheduled.is_one_shot {
            return scheduled.task.next_run_at.as_deref().and_then(parse_iso);
        }
        scheduled.job.next_run()
    }

    /// Stop and drop the in-memory job, with no telemetry side effects.
    fn stop_job(&self, task_id: &str) {
        let removed = self.scheduled_jobs.lock().shift_remove(task_id);
        if let Some(scheduled) = removed {
            scheduled.job.stop();
        }
    }

    /// What the task's runs sent and reported since. Read from the stored messages
    /// once per process; a failed read is tried again on the next run.
    async fn last_send_of(&self, task: &BackendCronTask) -> Option<TaskLastSend> {
        if !self.last_send.lock().contains_key(&task.id) {
            // A run that sent while the read was out wins over what the read found.
            if let Ok(read) = self.read_last_send(task).await {
                let mut entries = self.last_send.lock();
                if !entries.contains_key(&task.id) {
                    entries.insert(
                        task.id.clone(),
                        read.map(|record| LastSendEntry {
                            instruction: task.instruction.clone(),
                            record,
                        }),
                    );
                }
            }
        }
        self.last_send
            .lock()
            .get(&task.id)
            .cloned()
            .flatten()
            .filter(|entry| entry.instruction == task.instruction)
            .map(|entry| entry.record)
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
        let heading = format!("**Scheduled Task: {}**", task.name);
        let pattern = starts_with_pattern(&heading);
        let agent_id = task.agent_id.clone();
        let user_id = task.user_id.clone();
        let since = parse_iso(&task.created_at).unwrap_or_else(|| from_ms(0));
        let rows = crate::db::run(move |conn| {
            Ok(m::conversation_messages
                .inner_join(t::conversation_threads)
                .filter(m::role.eq(MessageRole::Agent))
                .filter(m::triggered_by.eq(MessageTrigger::CronTask))
                .filter(t::agent_id.eq(&agent_id))
                .filter(t::user_id.eq(&user_id))
                .filter(m::content.like(&pattern).escape('\\'))
                .filter(m::created_at.ge(DbDateTime(since)))
                .order(m::created_at.desc())
                .limit(LAST_SEND_ROWS)
                .select((m::content, m::tool_calls, m::created_at))
                .load::<(String, Option<Value>, DateTime<Utc>)>(conn)?)
        })
        .await;
        let rows = match rows {
            Ok(rows) => rows,
            Err(err) => {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[CronScheduler] Could not read what \"{}\" last sent",
                    task.name
                );
                return Err(err);
            }
        };
        let mut latest_report: Option<TaskReport> = None;
        // SQLite matches the prefix without regard to case.
        for (content, tool_calls, created_at) in rows
            .iter()
            .filter(|(content, _, _)| content.starts_with(&heading))
        {
            let messages = sent_messages(&stored_tool_calls(tool_calls.as_ref()));
            let at = created_at.timestamp_millis();
            if !messages.is_empty() {
                return Ok(Some(TaskLastSend {
                    messages: messages.join("\n"),
                    at,
                    latest_report,
                    reports: None,
                }));
            }
            if latest_report.is_none() {
                latest_report = Some(TaskReport {
                    text: js::trim(&content[heading.len()..]).to_string(),
                    at,
                });
            }
        }
        Ok(None)
    }

    /// A run that sent replaces the record, unless its task changed while it ran.
    /// Answers whether the run sent.
    fn note_sends(&self, task: &BackendCronTask, tool_calls: &[ToolCallRecord]) -> bool {
        let messages = sent_messages(tool_calls);
        if messages.is_empty() {
            return false;
        }
        if self.is_current(task) {
            self.last_send.lock().insert(
                task.id.clone(),
                Some(LastSendEntry {
                    instruction: task.instruction.clone(),
                    record: TaskLastSend {
                        messages: messages.join("\n"),
                        at: now_ms(),
                        latest_report: None,
                        reports: None,
                    },
                }),
            );
        }
        true
    }

    /// A later run's result, so the next run reads whether the finding still held. An empty result says nothing.
    fn note_report(&self, task: &BackendCronTask, body: &str) {
        let text = visible_text(body);
        let current = self.is_current(task);
        let mut entries = self.last_send.lock();
        let Some(Some(entry)) = entries.get_mut(&task.id) else {
            return;
        };
        if entry.instruction != task.instruction || text.is_empty() || !current {
            return;
        }
        entry.record.latest_report = Some(TaskReport { text, at: now_ms() });
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
        let scheduled = self.scheduled_jobs.lock().get(task_id).cloned();
        let Some(scheduled) = scheduled.filter(|scheduled| !scheduled.is_one_shot) else {
            return;
        };
        let changes = CronTaskChangeset {
            next_run_at: Some(scheduled.job.next_run()),
            last_run_at: ran_at.map(Some),
            ..CronTaskChangeset::default()
        };
        let id = task_id.to_string();
        let written = crate::db::run(move |conn| {
            diesel::update(ct::cron_tasks.filter(ct::id.eq(&id)))
                .set(&changes)
                .execute(conn)?;
            Ok(())
        })
        .await;
        if let Err(err) = written {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[CronScheduler] Failed to record the run of task {}",
                task_id
            );
        }
    }

    async fn delete_cron_task(&self, task_id: &str) -> anyhow::Result<()> {
        let id = task_id.to_string();
        crate::db::run(move |conn| {
            diesel::delete(ct::cron_tasks.filter(ct::id.eq(&id))).execute(conn)?;
            Ok(())
        })
        .await
    }

    /// Run a task once. False when a shutdown stopped the run before it delivered,
    /// which leaves the run due. `after_restart` tells the model that a run of the
    /// task may have stopped part-way at a restart. An overlapping run is skipped
    /// (`[CronScheduler] "<name>" is still running — skipping overlapping run`) and
    /// answers true.
    async fn execute_task(&'static self, task: BackendCronTask, after_restart: bool) -> bool {
        let run = {
            let mut running = self.running_tasks.lock();
            if running.contains_key(&task.id) {
                drop(running);
                log_warn!(
                    "[CronScheduler] \"{}\" is still running — skipping overlapping run",
                    task.name
                );
                return true;
            }
            let task_id = task.id.clone();
            let finished_id = task.id.clone();
            let handle = tokio::spawn(async move {
                let ran = self.run_task(task, after_restart).await;
                self.running_tasks.lock().remove(&finished_id);
                ran
            });
            let run = async move { handle.await.unwrap_or(true) }.boxed().shared();
            running.insert(task_id, run.clone());
            run
        };
        run.await
    }

    /// The body of one run: invoke, deliver per the task, record the outcome.
    async fn run_task(&'static self, task: BackendCronTask, after_restart: bool) -> bool {
        // A run that stops the process leaves its row, so the bound counts the boots that run it again.
        if let Err(err) = PENDING_WORK_SERVICE
            .begin(PendingWorkKind::Cron, &task.id, json!({}))
            .await
        {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[CronScheduler] Could not record the run of \"{}\"",
                task.name
            );
        }
        let start_time = now_ms();
        let bound_thread_id = task.thread_id.clone().filter(|thread| !thread.is_empty());
        // A task saved without an instruction runs on its name, the only text its author gave.
        let instruction = match js::trim(&task.instruction) {
            "" => task.name.clone(),
            instruction => instruction.to_string(),
        };

        log_info!(
            "[CronScheduler] Executing \"{}\" for user {}",
            task.name,
            task.user_id
        );

        let mut sent_calls: Vec<ToolCallRecord> = Vec::new();
        let mut stopped = false;
        let ran = self
            .run_task_body(
                &task,
                after_restart,
                start_time,
                bound_thread_id.as_deref(),
                &instruction,
                &mut sent_calls,
                &mut stopped,
            )
            .await;
        let ran = match ran {
            Ok(ran) => ran,
            Err(error) => {
                log_error!("[CronScheduler] \"{}\" failed: {}", task.name, error);
                self.track_run(&task, "error", &sent_calls, start_time);
                true
            }
        };
        // Every way out of the run, a failure included, is a run that ended,
        // except a shutdown before the delivery, which leaves the run due.
        if !stopped {
            self.record_run(&task.id, Some(Utc::now())).await;
            PENDING_WORK_SERVICE.finish(PendingWorkKind::Cron, &task.id);
        }
        ran
    }

    /// `cron task executed`, with the messages the run's tool calls sent.
    fn track_run(
        &self,
        task: &BackendCronTask,
        result: &str,
        sent_calls: &[ToolCallRecord],
        start_time: i64,
    ) {
        track_event(
            "cron task executed",
            Some(&task.user_id),
            Some(IndexMap::from([
                ("agent.id".to_string(), task.agent_id.clone()),
                ("cron.task.id".to_string(), task.id.clone()),
                ("cron.result".to_string(), result.to_string()),
                (
                    "cron.messages_sent".to_string(),
                    sent_message_list(sent_calls).len().to_string(),
                ),
                (
                    "cron.continue_in_thread".to_string(),
                    task.thread_id
                        .as_deref()
                        .is_some_and(|thread| !thread.is_empty())
                        .to_string(),
                ),
                ("cron.deliver_to".to_string(), task.deliver_to.clone()),
                (
                    "cron.duration_ms".to_string(),
                    (now_ms() - start_time).to_string(),
                ),
            ])),
        );
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_task_body(
        &'static self,
        task: &BackendCronTask,
        after_restart: bool,
        start_time: i64,
        bound_thread_id: Option<&str>,
        instruction: &str,
        sent_calls: &mut Vec<ToolCallRecord>,
        stopped: &mut bool,
    ) -> anyhow::Result<bool> {
        let shutdown = PENDING_WORK_SERVICE.shutdown_signal();
        // A thread-bound ("continue in this conversation") task resumes in its
        // originating thread; make sure that thread still exists before invoking —
        // it may have been deleted since scheduling (the cascade removes the row,
        // but the in-memory one-shot timer can still fire).
        if let Some(bound) = bound_thread_id {
            let id = bound.to_string();
            let thread: Option<String> = crate::db::run(move |conn| {
                Ok(t::conversation_threads
                    .filter(t::id.eq(&id))
                    .select(t::id)
                    .first(conn)
                    .optional()?)
            })
            .await?;
            if thread.is_none() {
                log_warn!(
                    "[CronScheduler] \"{}\" thread {} is gone — skipping",
                    task.name,
                    bound
                );
                return Ok(true);
            }
        }
        // A task that continues a conversation single-thread mode hides reads no history:
        // its answer goes to the one conversation (see `publish`), which that history is
        // not part of. It still delivers as a bound task, to its own channel alone.
        let history_thread_id = match bound_thread_id {
            Some(bound) if CONVERSATION_SERVICE.writable_thread_id(bound).await? == bound => {
                Some(bound.to_string())
            }
            _ => None,
        };
        let target = DeliveryTarget {
            deliver_to: task.deliver_to.clone(),
            channel_ids: parse_comma_list(task.channel_ids.as_deref()),
        };

        let last_send = if bound_thread_id.is_some() {
            None
        } else {
            self.last_send_of(task).await
        };
        // Invoke LLM directly (in-process). A bound task runs against its thread so
        // it sees the conversation history and can re-schedule another "wait" to
        // keep polling in-thread.
        let mut request = InvokeRequest {
            user_id: task.user_id.clone(),
            agent_id: task.agent_id.clone(),
            mode: InvokeMode::Cron,
            prompt: if bound_thread_id.is_some() {
                instruction.to_string()
            } else {
                scheduled_run_prompt(instruction, last_send.as_ref())
            },
            after_restart,
            abort_signal: Some(shutdown.clone()),
            ..InvokeRequest::default()
        };
        if let Some(thread_id) = &history_thread_id {
            request.thread_id = Some(thread_id.clone());
            request.origin_channel = task.origin_channel.as_deref().and_then(ChannelName::parse);
            request.origin_channel_id = task.origin_channel_id.clone();
        }
        // An unbound task posts within its delivery target, and only an unbound task recurs.
        if bound_thread_id.is_none() {
            request.posting_ceiling = Some(
                DELIVERY_TARGET_SERVICE
                    .ceiling(&task.agent_id, &target)
                    .await?,
            );
            request.last_send = last_send;
        }
        let result = invoke(request).await?;
        let withheld = |thread_id: Option<&str>, content: String| WithheldRun {
            agent_id: task.agent_id.clone(),
            user_id: task.user_id.clone(),
            thread_id: thread_id.map(str::to_string),
            content,
            triggered_by: MessageTrigger::CronTask,
            trigger_name: None,
            tool_calls: result.tool_calls.clone(),
        };
        let last_text = result
            .steps
            .last()
            .map(|step| step.text.clone())
            .unwrap_or_default();
        // A shutdown stopped the run. It delivers nothing, and a message it sent stays
        // in history. A run that sent nothing stays due; one that sent already reached
        // people, so it ends, as a run again after the restart would send it twice.
        // From here the run delivers, so a shutdown that starts later lets it end.
        if shutdown.is_cancelled() {
            let visible = visible_text(&last_text);
            let stopped_text = if visible.is_empty() {
                WITHHELD_RUN_TEXT.to_string()
            } else {
                visible
            };
            let content = match bound_thread_id {
                Some(_) => stopped_text,
                None => format!("**Scheduled Task: {}**\n\n{}", task.name, stopped_text),
            };
            OUTBOUND_MESSAGE_SERVICE
                .keep_withheld_run(withheld(bound_thread_id, content))
                .await?;
            if !sent_message_list(&result.tool_calls).is_empty() {
                return Ok(true);
            }
            *stopped = true;
            return Ok(false);
        }

        // Build channel-neutral routing for a bound task once (the origin
        // channel's own thread, recovered from the thread row); none for unbound.
        let channel_context = match bound_thread_id {
            Some(bound) => Some(
                MESSAGE_DELIVERY_SERVICE
                    .thread_context(
                        bound,
                        task.origin_channel.as_deref(),
                        task.origin_channel_id.as_deref(),
                    )
                    .await?
                    .context,
            ),
            None => None,
        };

        *sent_calls = result.tool_calls.clone();
        let sent = bound_thread_id.is_none() && self.note_sends(task, &result.tool_calls);
        let tool_calls = (!result.tool_calls.is_empty()).then(|| result.tool_calls.clone());

        // Budget exceeded — notify user and record the attempt
        if let Some(error) = result
            .error
            .as_ref()
            .filter(|error| error.kind == InvokeErrorType::BudgetExceeded)
        {
            let detail = error
                .detail
                .as_deref()
                .filter(|detail| !detail.is_empty())
                .map(|detail| format!(": {detail}"))
                .unwrap_or_default();
            let budget_message = format!(
                "**Scheduled Task: {}**\n\nThis task could not run — your organization's AI spending limit has been reached{detail}. Please contact your administrator to increase the budget.",
                task.name
            );
            // The tool calls of the steps before the limit go with the notice, so a
            // message the run already sent stays in its history.
            match bound_thread_id {
                Some(bound) => {
                    MESSAGE_DELIVERY_SERVICE
                        .publish(
                            &task.user_id,
                            bound,
                            &budget_message,
                            MessageTrigger::CronTask,
                            PublishOptions {
                                tool_calls,
                                channel_context,
                                ..PublishOptions::default()
                            },
                        )
                        .await?;
                }
                None => {
                    let delivery = DELIVERY_TARGET_SERVICE
                        .deliver(
                            &task.agent_id,
                            &task.user_id,
                            &target,
                            &budget_message,
                            TargetTrigger::CronTask,
                            TargetPublishOptions {
                                tool_calls,
                                ..TargetPublishOptions::default()
                            },
                        )
                        .await?;
                    if delivery.message.is_none() {
                        OUTBOUND_MESSAGE_SERVICE
                            .keep_withheld_run(withheld(None, budget_message))
                            .await?;
                    }
                }
            }
            self.track_run(task, "budget_exceeded", sent_calls, start_time);
            return Ok(true);
        }

        // Use only the last step's text (the final summary), not intermediate step texts
        let response_text = visible_text(&last_text);
        let body = if response_text.is_empty() {
            result.response.clone()
        } else {
            response_text.clone()
        };
        // A failed run's text is the error, not a finding.
        if bound_thread_id.is_none() && !sent && result.error.is_none() {
            self.note_report(task, &body);
        }

        if let Some(bound) = bound_thread_id {
            // A continuation replies in its conversation, with no "Scheduled Task"
            // header. An empty reply is a wait with nothing to say yet.
            if !response_text.is_empty() {
                // A continuation places images as a chat reply does (see share_file's
                // description). Its run gives `invoke` no workspace root, so placement
                // reads the default workspace too.
                let (content, attachment_ids) = place_reply_images(
                    bound,
                    &response_text,
                    result.attachment_ids.as_deref().unwrap_or_default(),
                    None,
                )
                .await;
                MESSAGE_DELIVERY_SERVICE
                    .publish(
                        &task.user_id,
                        bound,
                        &content,
                        MessageTrigger::CronTask,
                        PublishOptions {
                            tool_calls,
                            attachment_ids: Some(attachment_ids).filter(|ids| !ids.is_empty()),
                            channel_context,
                            ..PublishOptions::default()
                        },
                    )
                    .await?;
            } else {
                OUTBOUND_MESSAGE_SERVICE
                    .keep_withheld_run(withheld(Some(bound), body))
                    .await?;
            }
            log_info!(
                "[CronScheduler] \"{}\" completed in {}ms",
                task.name,
                now_ms() - start_time
            );
            self.track_run(
                task,
                if response_text.is_empty() {
                    "silent"
                } else {
                    "posted"
                },
                sent_calls,
                start_time,
            );
            return Ok(true);
        }

        // An unbound run reaches people only through what the agent posted. A run
        // that ended in an error could not post what happened, so its result goes
        // to the task's target, as does that of a run that posted nothing because
        // the risk gate refused a tool call or it ran out of steps. A run that did
        // post keeps its closing line, which says where it posted, to itself.
        let content = format!("**Scheduled Task: {}**\n\n{}", task.name, body);
        let failed = result.error.is_some()
            || (!sent && (has_risk_blocked_call(&result.tool_calls)? || result.step_limit_reached));
        let message = if failed {
            DELIVERY_TARGET_SERVICE
                .deliver(
                    &task.agent_id,
                    &task.user_id,
                    &target,
                    &content,
                    TargetTrigger::CronTask,
                    TargetPublishOptions {
                        tool_calls,
                        attachment_ids: result.attachment_ids.clone(),
                        ..TargetPublishOptions::default()
                    },
                )
                .await?
                .message
        } else {
            None
        };
        if message.is_none() {
            OUTBOUND_MESSAGE_SERVICE
                .keep_withheld_run(withheld(None, content))
                .await?;
        }

        log_info!(
            "[CronScheduler] \"{}\" completed in {}ms",
            task.name,
            now_ms() - start_time
        );
        self.track_run(
            task,
            if failed {
                "error"
            } else if sent {
                "posted"
            } else {
                "silent"
            },
            sent_calls,
            start_time,
        );
        Ok(true)
    }

    pub fn stop_all(&self) {
        let jobs: Vec<Arc<ScheduledJob>> = self
            .scheduled_jobs
            .lock()
            .drain(..)
            .map(|(_, job)| job)
            .collect();
        for scheduled in jobs {
            scheduled.job.stop();
        }
        self.last_send.lock().clear();
        log_info!("[CronScheduler] All cron tasks stopped");
    }
}

impl Default for CronSchedulerService {
    fn default() -> Self {
        Self::new()
    }
}

pub static CRON_SCHEDULER_SERVICE: LazyLock<CronSchedulerService> =
    LazyLock::new(CronSchedulerService::new);
