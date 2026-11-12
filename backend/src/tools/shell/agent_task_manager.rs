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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use futures::StreamExt;
use indexmap::IndexMap;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{oneshot, watch};

use crate::config::{CONFIG, CodingAgentName};
use crate::lib::agent_mcp_servers::agent_mcp_servers;
use crate::lib::coding_agents::coding_agent::{
    CodingAgent, CodingAgentEvent, CodingAgentMode, CodingAgentRefusal, CodingAgentRun,
    CodingAgentStopReason, CodingAgentTask, Effort, ModelTier,
};
use crate::lib::execution_environments::execution_environment::ProcessMark;
use crate::lib::execution_environments::get_execution_environment::get_execution_environment_for;
use crate::lib::execution_environments::leftover_process::stop_leftover_process;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::prompts::resume_prompt::RESUMED_CODING_TASK_PROMPT;
use crate::services::pending_work_service::{
    PENDING_WORK_SERVICE, PendingWorkItem, PendingWorkKind,
};
use crate::services::plugin_mcp_service::PLUGIN_MCP_SERVICE;
use crate::support::js::{len16, slice16};
use crate::{log_error, log_info, log_warn};

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
    /// True once drive() has finalized the state, and from the start for an
    /// entry with no run, so stop_task can await the final drain.
    pub driven: watch::Sender<bool>,
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

/// The id-or-reaped refusal of a task the manager does not hold.
fn missing(reaped: &VecDeque<String>, task_id: &str) -> anyhow::Error {
    if reaped.iter().any(|id| id == task_id) {
        anyhow::anyhow!("Task {task_id} has already ended and been cleaned up")
    } else {
        anyhow::anyhow!("Unknown task: {task_id}")
    }
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
        let running = self
            .tasks
            .lock()
            .values()
            .filter(|entry| !entry.state.lock().completed)
            .count();
        self.starting.load(Ordering::SeqCst) + running
    }

    /// Fails with `Max concurrent agent tasks (3) reached` at the cap, with the
    /// agent's own refusal when it is unavailable, and without launching when the
    /// task cannot be recorded, since a restart would lose it.
    pub async fn start_task(
        self: &Arc<Self>,
        params: AgentTaskParams,
    ) -> anyhow::Result<StartedTask> {
        if self.running_count() >= MAX_CONCURRENT {
            anyhow::bail!("Max concurrent agent tasks ({MAX_CONCURRENT}) reached");
        }

        // Before the row: an agent that is not available refuses the task, and no
        // boot retries it.
        let name = params.agent.unwrap_or_else(|| CONFIG.coding_agent());
        let agent = (self.resolve_agent)(name)?;
        let task_id = uuid::Uuid::new_v4().to_string();
        let work = CodingTaskWork {
            params: AgentTaskParams {
                agent: Some(name),
                ..params
            },
            session_id: None,
            process: None,
            finished: None,
        };
        self.starting.fetch_add(1, Ordering::SeqCst);
        let begun = PENDING_WORK_SERVICE
            .begin(
                PendingWorkKind::CodingTask,
                &task_id,
                serde_json::to_value(&work)?,
            )
            .await;
        self.starting.fetch_sub(1, Ordering::SeqCst);
        begun?;
        let id = agent.id();
        self.launch(&task_id, agent, work.params.clone(), work.params);
        Ok(StartedTask { task_id, agent: id })
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
        // The bound gave these up, so nothing relaunches them, and no poll can
        // reach a run left behind.
        for item in given_up {
            let Ok(work) = serde_json::from_value::<CodingTaskWork>(item.payload) else {
                continue;
            };
            if let Some(process) = work.process
                && stop_leftover_process(process).await
            {
                log_warn!(
                    json!({ "taskId": item.key }),
                    "[AgentTask] Stopped the run of a task the restarts gave up"
                );
            }
        }
        // A relaunch gives the task the plugins' MCP servers, which no turn has
        // read yet at boot.
        let relaunches = items.iter().any(|item| {
            item.payload
                .get("finished")
                .is_none_or(serde_json::Value::is_null)
        });
        if relaunches {
            PLUGIN_MCP_SERVICE.read_configs().await;
        }
        for item in items {
            let continued = match serde_json::from_value::<CodingTaskWork>(item.payload) {
                Ok(work) => self.resume_one(&item.key, work).await,
                Err(err) => Err(err.into()),
            };
            if let Err(err) = continued {
                // An agent whose credentials a restart removed cannot continue its task.
                log_error!(
                    json!({ "err": err_json(&err), "taskId": item.key }),
                    "[AgentTask] Could not continue a task a restart stopped"
                );
                PENDING_WORK_SERVICE.end(PendingWorkKind::CodingTask, &item.key);
            }
        }
    }

    async fn resume_one(
        self: &Arc<Self>,
        task_id: &str,
        work: CodingTaskWork,
    ) -> anyhow::Result<()> {
        let name = work.params.agent.unwrap_or_else(|| CONFIG.coding_agent());
        // A result nobody reads is a boot like any other, so the bound drops it.
        // Reading one needs no agent, so it outlives the agent's credentials.
        if let Some(finished) = work.finished {
            let entry = Arc::new(TaskEntry {
                mode: work.params.mode.unwrap_or_default(),
                state: Mutex::new(TaskState {
                    agent: name,
                    output_buffer: String::new(),
                    completed: true,
                    result: finished.result,
                    turns: finished.turns,
                    stop_reason: finished.stop_reason,
                    session_id: work.session_id,
                    refusals: finished.refusals,
                }),
                waiters: Mutex::new(Vec::new()),
                reading: AtomicBool::new(false),
                run: None,
                params: work.params,
                stopping: AtomicBool::new(false),
                driven: watch::channel(true).0,
            });
            self.tasks.lock().insert(task_id.to_string(), entry);
            return Ok(());
        }
        let agent = (self.resolve_agent)(name)?;
        if let Some(process) = work.process
            && stop_leftover_process(process).await
        {
            log_warn!(
                json!({ "taskId": task_id }),
                "[AgentTask] Stopped the run a crash left running"
            );
        }
        let relaunch = match &work.session_id {
            Some(session_id) => AgentTaskParams {
                session_id: Some(session_id.clone()),
                prompt: RESUMED_CODING_TASK_PROMPT.to_string(),
                ..work.params.clone()
            },
            None => work.params.clone(),
        };
        self.launch(task_id, agent, work.params, relaunch);
        Ok(())
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
        let task = CodingAgentTask {
            task_id: task_id.to_string(),
            prompt: params.prompt.clone(),
            workdir: params.workdir.clone(),
            // The environment that will run it, which the workdir decides: a thread
            // rooted outside the container's mounts runs on the host, and the host's
            // `PATH` and `HOME` are exactly what the container's environment drops.
            env: get_execution_environment_for(params.workdir.as_deref()).base_env(),
            mode: params.mode.unwrap_or_default(),
            model_tier: params.model_tier,
            effort: params.effort,
            max_turns: params.max_turns.unwrap_or(DEFAULT_MAX_TURNS),
            append_system_prompt: params.append_system_prompt.clone(),
            session_id: params.session_id.clone(),
            debug: params.debug,
            mcp_servers: agent_mcp_servers(params.workdir.as_deref()),
        };

        // A session it resumes is its session until the agent reports one, so a
        // restart before that report relaunches the same session again.
        let state = TaskState {
            agent: agent.id(),
            output_buffer: String::new(),
            completed: false,
            result: None,
            turns: None,
            stop_reason: None,
            session_id: params.session_id.clone().filter(|id| !id.is_empty()),
            refusals: None,
        };
        let (prompt_len, max_turns, mode, mcp_servers) = (
            len16(&task.prompt),
            task.max_turns,
            task.mode,
            task.mcp_servers.len(),
        );
        let run = agent.run(task);
        let entry = Arc::new(TaskEntry {
            mode,
            state: Mutex::new(state),
            waiters: Mutex::new(Vec::new()),
            reading: AtomicBool::new(false),
            run: Some(run.clone()),
            params: original,
            stopping: AtomicBool::new(false),
            driven: watch::channel(false).0,
        });
        self.tasks.lock().insert(task_id.to_string(), entry.clone());
        self.record(task_id, &entry);
        // A run can start its process after this, and the next boot stops a
        // process left running only by the mark recorded here.
        {
            let manager = self.clone();
            let entry = entry.clone();
            let run = run.clone();
            let task_id = task_id.to_string();
            let mut driven = entry.driven.subscribe();
            tokio::spawn(async move {
                tokio::select! {
                    biased;
                    _ = run.started() => manager.record(&task_id, &entry),
                    _ = driven.wait_for(|driven| *driven) => {}
                }
            });
        }

        log_info!(
            json!({
                "taskId": task_id,
                "agent": agent.id(),
                "promptLen": prompt_len,
                "maxTurns": max_turns,
                "mode": mode,
                "mcpServers": mcp_servers,
            }),
            "[AgentTask] starting task"
        );

        // stop_task awaits the finalize through `driven` instead of racing it.
        let manager = self.clone();
        let task_id = task_id.to_string();
        tokio::spawn(async move {
            manager.drive(&task_id, &entry, &*agent, &*run).await;
            entry.driven.send_replace(true);
        });
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
        let entry = self.tasks.lock().get(task_id).cloned();
        let Some(entry) = entry else {
            return Err(missing(&self.reaped.lock(), task_id));
        };
        let pending_read = || anyhow::anyhow!("Task {task_id} already has a pending read");
        if entry.reading.load(Ordering::SeqCst) {
            return Err(pending_read());
        }

        // Immediate drain if anything to deliver; otherwise the waiter is
        // registered under the state lock, so output that lands after the check
        // wakes it.
        let woken = {
            let state = entry.state.lock();
            if !state.output_buffer.is_empty() || state.completed {
                drop(state);
                return Ok(self.drain_and_maybe_reap(task_id, &entry));
            }
            if entry
                .reading
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return Err(pending_read());
            }
            let (tx, rx) = oneshot::channel();
            entry.waiters.lock().push(tx);
            rx
        };

        // Wait for output or completion, bounded by wait_ms.
        let _ = tokio::time::timeout(
            Duration::from_millis(wait_ms.unwrap_or(DEFAULT_WAIT_MS)),
            woken,
        )
        .await;
        entry.reading.store(false, Ordering::SeqCst);

        // The entry might have been reaped while we waited — by a concurrent
        // stop_task, or by kill_all. The state we still hold has the real
        // outcome, so report that rather than inventing a failure; its output has
        // already been delivered to whoever reaped it.
        let still_there = self.tasks.lock().get(task_id).cloned();
        match still_there {
            None => Ok(drain_task(&mut entry.state.lock())),
            Some(entry) => Ok(self.drain_and_maybe_reap(task_id, &entry)),
        }
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
        let entry = self.tasks.lock().get(task_id).cloned();
        let Some(entry) = entry else {
            return Err(missing(&self.reaped.lock(), task_id));
        };

        if !entry.state.lock().completed {
            // A run that has already exited is mid-finalize, not running: its result
            // may be read but not yet written to the state. Stopping it and flagging
            // the stop would relabel a task that finished on its own as stopped and
            // throw away its real result.
            if let Some(run) = entry.run.as_ref().filter(|run| !run.exited()) {
                entry.stopping.store(true, Ordering::SeqCst);
                run.stop();
            }
            // Let drive() reach its finalize: the run's stream ends when the agent
            // dies, and the state picks up its result/turns/session_id. Bounded so an
            // agent that ignores the stop can't hang the tool call.
            let mut driven = entry.driven.subscribe();
            let _ = tokio::time::timeout(
                Duration::from_millis(STOP_WAIT_MS),
                driven.wait_for(|driven| *driven),
            )
            .await;
            let unfinished = {
                let mut state = entry.state.lock();
                if state.completed {
                    false
                } else {
                    // Outlived the forced stop, or a grandchild is still holding the
                    // agent's output open so the stream can never end. Report the stop
                    // anyway rather than handing back a half-finished state; the
                    // buffered output still goes out in the drain below.
                    state.completed = true;
                    state.stop_reason = Some(TaskStopReason::Stopped);
                    state.result.get_or_insert_with(|| {
                        "Task stopped; it did not exit cleanly, so no final result was captured."
                            .to_string()
                    });
                    true
                }
            };
            if unfinished {
                // Wake anything parked in read_status. Only drive()'s finalize
                // notifies, and drive() finalizing is what did not happen here.
                Self::notify(&entry);
            }
        }

        let status = drain_task(&mut entry.state.lock());
        self.reap(task_id);
        log_info!(
            json!({ "taskId": task_id, "stopReason": status.stop_reason }),
            "[AgentTask] stopped"
        );
        Ok(status)
    }

    pub fn kill_all(&self) {
        let tasks: Vec<Arc<TaskEntry>> = self.tasks.lock().drain().map(|(_, e)| e).collect();
        for entry in tasks {
            {
                let mut state = entry.state.lock();
                if !state.completed {
                    if let Some(run) = &entry.run {
                        run.stop();
                    }
                    state.completed = true;
                    state.stop_reason = Some(TaskStopReason::Error);
                }
            }
            Self::notify(&entry);
        }
        self.reaped.lock().clear();
    }

    fn drain_and_maybe_reap(&self, task_id: &str, entry: &TaskEntry) -> AgentTaskStatus {
        let status = drain_task(&mut entry.state.lock());
        if !status.completed {
            return status;
        }
        // A read that hands out output keeps the entry for the poll after it. The
        // agent has read how the task ended either way, so no restart keeps it.
        if status.output.is_empty() {
            self.reap(task_id);
        } else {
            PENDING_WORK_SERVICE.end(PendingWorkKind::CodingTask, task_id);
        }
        status
    }

    /// Forget a task, remembering the id so a later poll can say why it's gone.
    /// The reaped list keeps at most `MAX_CONCURRENT * 10` ids.
    fn reap(&self, task_id: &str) {
        self.tasks.lock().remove(task_id);
        // The agent has read how the task ended, so no restart needs to keep it.
        PENDING_WORK_SERVICE.end(PendingWorkKind::CodingTask, task_id);
        let mut reaped = self.reaped.lock();
        if !reaped.iter().any(|id| id == task_id) {
            reaped.push_back(task_id.to_string());
        }
        // Keep the reaped set from growing without bound.
        if reaped.len() > MAX_CONCURRENT * 10 {
            reaped.pop_front();
        }
    }

    /// Keep what a relaunch, or the report of an ended run, needs after a restart.
    fn record(&self, task_id: &str, entry: &TaskEntry) {
        let state = entry.state.lock().clone();
        let session_id = state.session_id.clone().filter(|id| !id.is_empty());
        if state.completed {
            let work = CodingTaskWork {
                params: entry.params.clone(),
                session_id,
                process: None,
                finished: Some(FinishedTask {
                    result: state.result,
                    turns: state.turns,
                    stop_reason: state.stop_reason,
                    refusals: state.refusals,
                }),
            };
            PENDING_WORK_SERVICE.settle(PendingWorkKind::CodingTask, task_id, work_value(&work));
            return;
        }
        let work = CodingTaskWork {
            params: entry.params.clone(),
            session_id,
            process: entry.run.as_ref().and_then(|run| run.mark()),
            finished: None,
        };
        PENDING_WORK_SERVICE.update(PendingWorkKind::CodingTask, task_id, work_value(&work));
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
        &self,
        task_id: &str,
        entry: &TaskEntry,
        agent: &dyn CodingAgent,
        run: &dyn CodingAgentRun,
    ) {
        let mut texts: Vec<String> = Vec::new();
        let mut outcome: Option<(
            CodingAgentStopReason,
            i64,
            String,
            Option<Vec<CodingAgentRefusal>>,
        )> = None;

        if let Some(mut events) = run.take_events() {
            while let Some(event) = events.next().await {
                match event {
                    CodingAgentEvent::Text { text } => {
                        append_buffer(&mut entry.state.lock(), &text);
                        texts.push(text);
                        Self::notify(entry);
                    }
                    CodingAgentEvent::Session { session_id } => {
                        // Recorded as it arrives so a *stopped* task can be resumed —
                        // including when stop_task has to give up on this loop ever
                        // ending and finalize the state itself, and when a restart
                        // stops it. drain_task only exposes it once the task is
                        // complete, so an in-flight poll is unaffected.
                        entry.state.lock().session_id = Some(session_id);
                        self.record(task_id, entry);
                    }
                    CodingAgentEvent::Result {
                        stop_reason,
                        turns,
                        message,
                        refusals,
                    } => outcome = Some((stop_reason, turns, message, refusals)),
                }
            }
        }

        let full_text = (!texts.is_empty()).then(|| texts.join("\n\n"));
        // The contract says every stream ends with a result; an adapter that breaks
        // it gets a failed task rather than a task that never completes.
        let (outcome_reason, turns, message, refusals) = outcome.unwrap_or_else(|| {
            (
                CodingAgentStopReason::Error,
                0,
                format!("{} ended without reporting a result", agent.display_name()),
                None,
            )
        });

        let mut stop_reason = TaskStopReason::from(outcome_reason);
        let mut result = if entry.stopping.load(Ordering::SeqCst) {
            // We are why it died, so don't read its exit as a failure. Keep whatever
            // text it managed to produce.
            stop_reason = TaskStopReason::Stopped;
            full_text.unwrap_or_else(|| "Task stopped before producing any output.".to_string())
        } else if outcome_reason == CodingAgentStopReason::EndTurn {
            full_text.unwrap_or_else(|| message.clone())
        } else {
            match full_text {
                Some(text) => format!("{text}\n\n[{}]: {message}", outcome_reason.as_str()),
                None => format!("Error ({}): {message}", outcome_reason.as_str()),
            }
        };

        let refusals = refusals.unwrap_or_default();
        let mut kept_refusals = None;
        if !refusals.is_empty() {
            // A refused action is work the task did not do, so a run that otherwise
            // ended cleanly is not reported as a success.
            if stop_reason == TaskStopReason::EndTurn {
                stop_reason = TaskStopReason::Refused;
            }
            result.push_str(&format!(
                "\n\n{}",
                describe_refusals(agent.display_name(), &refusals)
            ));
            let mut props = IndexMap::new();
            props.insert("task.id".to_string(), task_id.to_string());
            props.insert("task.agent".to_string(), agent.id().as_str().to_string());
            props.insert("task.mode".to_string(), entry.mode.as_str().to_string());
            props.insert(
                "task.stop_reason".to_string(),
                outcome_reason.as_str().to_string(),
            );
            props.insert("task.refusals".to_string(), refusals.len().to_string());
            track_event(
                "coding task refused",
                Some(&CONFIG.owner_user_id()),
                Some(props),
            );
            kept_refusals = Some(refusals);
        }

        {
            let mut state = entry.state.lock();
            if kept_refusals.is_some() {
                state.refusals = kept_refusals;
            }
            state.completed = true;
            state.result = Some(result);
            state.turns = Some(turns);
            state.stop_reason = Some(stop_reason);
        }

        self.record(task_id, entry);
        Self::notify(entry);
        log_info!(
            json!({ "taskId": task_id, "stopReason": stop_reason, "turns": turns }),
            "[AgentTask] completed"
        );
    }
}

/// A task's row as JSON.
fn work_value(work: &CodingTaskWork) -> serde_json::Value {
    serde_json::to_value(work).unwrap_or_default()
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
        agent: state.agent,
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

#[cfg(test)]
#[path = "agent_task_manager_tests.rs"]
mod tests;
