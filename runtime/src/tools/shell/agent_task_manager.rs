//! Agent task manager for `coding_agent` / `coding_agent_status` / `coding_agent_stop`.
//!
//! Port of the upstream Lens Agents shell sandbox's agent task manager. Hands
//! each task to the configured `CodingAgent`, buffers the run's text for
//! drain-on-read polling, and tracks completion state. How the agent is
//! launched and read is the adapter's business (`lib::coding_agents`); this
//! module sees only the neutral events a run emits.
//!
//! One in-process manager per runtime, at most MAX_CONCURRENT tasks running at
//! once. The agent invokes `start_task()` via the `coding_agent` tool, polls via
//! `read_status()` from `coding_agent_status`, and abandons a task via
//! `stop_task()` from `coding_agent_stop`.
//!
//! A task is pending work from its start until the agent has read how it ended.
//! The boot relaunches a task a restart stopped, resuming its session when one
//! was reported, and keeps the result of a task that ended unread. A relaunch
//! first stops the process a crash left running, so two runs never share a session.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, LazyLock};

use futures::future::{BoxFuture, Shared};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::config::CodingAgentName;
use crate::lib::coding_agents::coding_agent::{
    CodingAgent, CodingAgentMode, CodingAgentRefusal, CodingAgentRun, CodingAgentStopReason,
    Effort, ModelTier,
};
use crate::lib::execution_environments::execution_environment::ProcessMark;
use crate::services::pending_work_service::PendingWorkItem;
use crate::support::js::{len16, slice16};

pub const MAX_CONCURRENT: usize = 3;
pub const DEFAULT_WAIT_MS: u64 = 5_000;
pub const DEFAULT_MAX_TURNS: i64 = 100;
/// 1 MiB.
pub const MAX_BUFFER_SIZE: usize = 1024 * 1024;
/// How long stop_task waits for a stopped run's stream to end before reporting
/// the stop itself. Covers the adapter's graceful-then-forced termination.
pub const STOP_WAIT_MS: u64 = 2_500;

/// What a task was started with. Kept in its `pending_work` row.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<CodingAgentName>,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workdir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub append_system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<CodingAgentMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_tier: Option<ModelTier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<Effort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debug: Option<bool>,
}

/// `refused`: the agent finished, but its permission checks refused part of the work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStopReason {
    EndTurn,
    MaxTurns,
    Error,
    Stopped,
    Refused,
}

impl TaskStopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStopReason::EndTurn => "end_turn",
            TaskStopReason::MaxTurns => "max_turns",
            TaskStopReason::Error => "error",
            TaskStopReason::Stopped => "stopped",
            TaskStopReason::Refused => "refused",
        }
    }
}

impl From<CodingAgentStopReason> for TaskStopReason {
    fn from(reason: CodingAgentStopReason) -> Self {
        match reason {
            CodingAgentStopReason::EndTurn => TaskStopReason::EndTurn,
            CodingAgentStopReason::MaxTurns => TaskStopReason::MaxTurns,
            CodingAgentStopReason::Error => TaskStopReason::Error,
        }
    }
}

/// What `coding_agent_status` and `coding_agent_stop` return.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskStatus {
    pub agent: CodingAgentName,
    pub output: String,
    pub completed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<TaskStopReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refusals: Option<Vec<CodingAgentRefusal>>,
}

/// What `coding_agent` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedTask {
    pub task_id: String,
    pub agent: CodingAgentName,
}

/// How a run ended, kept until `coding_agent_status` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishedTask {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<TaskStopReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusals: Option<Vec<CodingAgentRefusal>>,
}

/// A task, as `pending_work` holds it until the agent has read how it ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingTaskWork {
    /// What the task was started with; `agent` is always set.
    pub params: AgentTaskParams,
    /// The session the agent reported, which a relaunch resumes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The running agent's process, which a relaunch stops first when a crash left it running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<ProcessMark>,
    /// How the run ended, kept until `coding_agent_status` reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished: Option<FinishedTask>,
}

#[derive(Debug, Clone)]
pub struct TaskState {
    pub agent: CodingAgentName,
    pub output_buffer: String,
    pub completed: bool,
    pub result: Option<String>,
    pub turns: Option<i64>,
    pub stop_reason: Option<TaskStopReason>,
    pub session_id: Option<String>,
    pub refusals: Option<Vec<CodingAgentRefusal>>,
}

/// One task the manager knows of.
pub struct TaskEntry {
    pub mode: CodingAgentMode,
    pub state: Mutex<TaskState>,
    /// Woken by new output or completion.
    pub waiters: Mutex<Vec<oneshot::Sender<()>>>,
    pub reading: AtomicBool,
    /// Absent for a task whose run ended before a restart, kept only to report its result.
    pub run: Option<Arc<dyn CodingAgentRun>>,
    /// What the task was started with; `agent` is always set.
    pub params: AgentTaskParams,
    /// Set by stop_task so drive()'s finalize reports `stopped`, not `error`.
    pub stopping: AtomicBool,
    /// The drive() future, so stop_task can await the final drain.
    pub driver: Mutex<Option<Shared<BoxFuture<'static, ()>>>>,
}

/// Resolves an agent by name, failing for one that is unavailable.
pub type ResolveAgent =
    Arc<dyn Fn(CodingAgentName) -> anyhow::Result<Arc<dyn CodingAgent>> + Send + Sync>;

pub struct AgentTaskManager {
    tasks: Mutex<HashMap<String, Arc<TaskEntry>>>,
    /// Ids of reaped tasks, oldest first, so a later poll can say why one is gone.
    reaped: Mutex<VecDeque<String>>,
    /// Starts waiting for their pending-work row, which hold a slot already.
    starting: AtomicUsize,
    resolve_agent: ResolveAgent,
}

impl AgentTaskManager {
    /// `resolve_agent` defaults to `get_coding_agent`.
    pub fn new(resolve_agent: Option<ResolveAgent>) -> Self {
        let resolve_agent = resolve_agent.unwrap_or_else(|| {
            let resolve: ResolveAgent = Arc::new(|name: CodingAgentName| {
                crate::lib::coding_agents::get_coding_agent::get_coding_agent(Some(name))
            });
            resolve
        });
        AgentTaskManager {
            tasks: Mutex::new(HashMap::new()),
            reaped: Mutex::new(VecDeque::new()),
            starting: AtomicUsize::new(0),
            resolve_agent,
        }
    }

    /// Number of tasks that haven't completed yet.
    pub fn running_count(&self) -> usize {
        todo!()
    }

    /// Fails with `Max concurrent agent tasks (3) reached` at the cap, with the
    /// agent's own refusal when it is unavailable, and without launching when the
    /// task cannot be recorded, since a restart would lose it.
    pub async fn start_task(
        self: &Arc<Self>,
        params: AgentTaskParams,
    ) -> anyhow::Result<StartedTask> {
        todo!()
    }

    /// Continue the tasks a restart stopped, under their own ids, so the agent's
    /// next poll finds them. A task with a session resumes it; one stopped before
    /// it reported a session starts again. A task that ended unread reports its
    /// result. The runs of `given_up` tasks a crash left running are stopped.
    pub async fn resume(
        self: &Arc<Self>,
        items: Vec<PendingWorkItem>,
        given_up: Vec<PendingWorkItem>,
    ) {
        todo!()
    }

    async fn resume_one(
        self: &Arc<Self>,
        task_id: &str,
        work: CodingTaskWork,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Run `params` as task `task_id` on `agent`. `original` is what the task was
    /// started with, which the pending-work row keeps across relaunches.
    fn launch(
        self: &Arc<Self>,
        task_id: &str,
        agent: Arc<dyn CodingAgent>,
        original: AgentTaskParams,
        params: AgentTaskParams,
    ) {
        todo!()
    }

    /// Drain the buffered output, waiting up to `wait_ms` (default 5000) for some
    /// when there is none. Fails for an unknown task
    /// (`Unknown task: <id>`), a reaped one
    /// (`Task <id> has already ended and been cleaned up`) and one already being
    /// read (`Task <id> already has a pending read`).
    pub async fn read_status(
        &self,
        task_id: &str,
        wait_ms: Option<u64>,
    ) -> anyhow::Result<AgentTaskStatus> {
        todo!()
    }

    /// Terminate a running task and hand back whatever it produced before it died.
    ///
    /// The entry is reaped unconditionally — the final output goes out in this
    /// response, so nothing is left to poll for and the concurrency slot is freed
    /// immediately. That is the point of the call: a task that went the wrong way
    /// otherwise holds one of MAX_CONCURRENT slots until it burns its whole turn
    /// budget.
    ///
    /// Unlike `read_status` this ignores `reading`: the escape hatch has to work
    /// even while another step is parked in a poll. Whichever of the two drains
    /// first gets the output, and the reap is idempotent.
    pub async fn stop_task(&self, task_id: &str) -> anyhow::Result<AgentTaskStatus> {
        todo!()
    }

    pub fn kill_all(&self) {
        todo!()
    }

    fn drain_and_maybe_reap(&self, task_id: &str, entry: &TaskEntry) -> AgentTaskStatus {
        todo!()
    }

    /// Forget a task, remembering the id so a later poll can say why it's gone.
    /// The reaped list keeps at most `MAX_CONCURRENT * 10` ids.
    fn reap(&self, task_id: &str) {
        todo!()
    }

    /// Keep what a relaunch, or the report of an ended run, needs after a restart.
    fn record(&self, task_id: &str, entry: &TaskEntry) {
        todo!()
    }

    fn notify(entry: &TaskEntry) {
        let waiters = std::mem::take(&mut *entry.waiters.lock());
        for waiter in waiters {
            let _ = waiter.send(());
        }
    }

    /// Read the run's events into the entry's state until the stream ends, then
    /// finalize the result (emitting `coding task refused` when the agent's checks
    /// refused actions).
    async fn drive(
        self: Arc<Self>,
        task_id: &str,
        entry: Arc<TaskEntry>,
        agent: Arc<dyn CodingAgent>,
        run: Arc<dyn CodingAgentRun>,
    ) {
        todo!()
    }
}

pub fn describe_refusals(display_name: &str, refusals: &[CodingAgentRefusal]) -> String {
    let lines: Vec<String> = refusals
        .iter()
        .map(|r| format!("- {}: {}", r.action, r.target))
        .collect();
    format!(
        "[refused]: {display_name} did not run these actions, because its permission checks refused them:\n{}",
        lines.join("\n")
    )
}

/// Append text, keeping the newest `MAX_BUFFER_SIZE` UTF-16 units behind a
/// truncation marker once the buffer grows past it.
pub fn append_buffer(state: &mut TaskState, text: &str) {
    state.output_buffer.push_str(text);
    let length = len16(&state.output_buffer);
    if length > MAX_BUFFER_SIZE {
        let start = length - MAX_BUFFER_SIZE;
        state.output_buffer = format!(
            "[...output truncated...]\n{}",
            slice16(&state.output_buffer, start, length)
        );
    }
}

pub fn drain_task(state: &mut TaskState) -> AgentTaskStatus {
    let output = std::mem::take(&mut state.output_buffer);
    let completed = state.completed;
    AgentTaskStatus {
        agent: state.agent.clone(),
        output,
        completed,
        result: if completed {
            state.result.clone()
        } else {
            None
        },
        turns: if completed { state.turns } else { None },
        stop_reason: if completed { state.stop_reason } else { None },
        session_id: if completed {
            state.session_id.clone()
        } else {
            None
        },
        refusals: if completed {
            state.refusals.clone()
        } else {
            None
        },
    }
}

/// Singleton for the tools to share across tool calls.
static AGENT_TASK_MANAGER: LazyLock<RwLock<Option<Arc<AgentTaskManager>>>> =
    LazyLock::new(|| RwLock::new(None));

pub fn get_agent_task_manager() -> Arc<AgentTaskManager> {
    if let Some(manager) = AGENT_TASK_MANAGER.read().as_ref() {
        return manager.clone();
    }
    AGENT_TASK_MANAGER
        .write()
        .get_or_insert_with(|| Arc::new(AgentTaskManager::new(None)))
        .clone()
}

/// Test-only: replace the singleton with a manager built on a stub agent.
pub fn set_agent_task_manager_for_tests(manager: Option<Arc<AgentTaskManager>>) {
    *AGENT_TASK_MANAGER.write() = manager;
}
