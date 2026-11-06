//! Goal Service (Agent-Runtime)
//!
//! Owns durable "goals" — objectives the agent pursues autonomously across many
//! turns, unattended, until a cheap classification gate judges them complete or
//! they hit a turn / token / stall cap. One active goal per thread.
//!
//! Design (mirrors heartbeat_service.rs + cron_scheduler_service.rs):
//! - Background continuation loop runs in-process, fire-and-forget, per goal.
//! - Completion is decided ONLY by the classification gate (no model-facing
//!   update tool), fail → CONTINUE so the loop never completes prematurely; caps
//!   bound it.
//! - Turns run through `THREAD_TURN_SERVICE.run()`, the per-thread mutex shared
//!   with the conversation engine's `chat()`, so a goal turn and an interactive user
//!   turn never invoke the same thread concurrently. User turns interleave
//!   between goal turns. Goal turns never open a steerable window, so a message
//!   arriving mid-goal-turn is not injected into it.
//! - State of record is the `goals` table; the in-memory runtime map only holds
//!   the abort handle + running flag, so a restart cleanly resumes from the DB.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::db::models::Goal;
use crate::services::channel_adapter_interface::{ChannelName, ChatPlatform};
use crate::types::{TaskLastSend, ToolCallRecord};

/// How many of a goal's stored turns a turn reads for the messages the goal sent.
const GOAL_SEND_ROWS: i64 = 20;

/// Statuses a goal can be in while still "live" (loop should run / can resume).
const LIVE_STATUSES: [&str; 2] = ["active", "paused"];

/// The channel the goal was started in, where its turns deliver and ask for help.
fn goal_channel(goal: &Goal) -> ChannelName {
    ChatPlatform::parse(&goal.origin_channel)
        .map(ChannelName::from)
        .unwrap_or(ChannelName::Websocket)
}

/// A goal loop's handles in this process.
struct GoalRuntime {
    is_running: AtomicBool,
    aborted: AtomicBool,
    /// Cancels the in-flight goal turn so stop/pause take effect immediately.
    abort: CancellationToken,
    /// The boot restored the goal, and the restart may have stopped its last turn part-way.
    after_restart: AtomicBool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartGoalInput {
    pub user_id: String,
    pub agent_id: String,
    pub thread_id: String,
    pub objective: String,
    /// Unset, the deployment's default budget.
    pub token_budget: Option<i64>,
    /// Originating channel for scoped delivery of goal-turn output.
    pub origin_channel: String,
    pub origin_channel_id: Option<String>,
}

/// What one goal turn did.
struct GoalTurn {
    text: String,
    tokens: i64,
    had_tool_calls: bool,
    budget_exceeded: bool,
}

pub struct GoalService {
    /// Per-goal runtime handles, keyed by goalId. DB is the source of truth.
    runtimes: Mutex<HashMap<String, Arc<GoalRuntime>>>,
}

impl GoalService {
    pub fn new() -> Self {
        Self {
            runtimes: Mutex::new(HashMap::new()),
        }
    }

    /// Whether any goal loop is live, including one sleeping between turns.
    pub fn has_live_loops(&self) -> bool {
        !self.runtimes.lock().is_empty()
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /// Create (or replace) the active goal on a thread and start its loop.
    /// One active goal per thread: any existing active/paused goal is stopped.
    /// Fails with `Goal objective is required` for an empty objective and
    /// `Goal objective is too long (max <n> characters)` past `GOAL_MAX_OBJECTIVE_CHARS`.
    pub async fn start_goal(&self, input: StartGoalInput) -> anyhow::Result<Goal> {
        todo!()
    }

    /// Re-start loops for every active goal on boot (resets the stall counter).
    pub async fn restore_active_goals(&self, agent_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Signal every running loop to stop after its current turn (graceful shutdown).
    pub fn stop_all(&self) {
        todo!()
    }

    // ========================================================================
    // Queries + user-controlled state changes
    // ========================================================================

    /// The current live (active or paused) goal on a thread, if any.
    pub async fn get_goal_for_thread(&self, thread_id: &str) -> anyhow::Result<Option<Goal>> {
        todo!()
    }

    pub async fn get_goal_by_id(&self, goal_id: &str) -> anyhow::Result<Option<Goal>> {
        todo!()
    }

    /// All goals for an agent, newest first (management/list view).
    pub async fn list_goals(&self, agent_id: &str) -> anyhow::Result<Vec<Goal>> {
        todo!()
    }

    /// Stop a goal by id; aborts its loop. No-op if already terminal.
    pub async fn stop_goal(&self, goal_id: &str) -> anyhow::Result<Option<Goal>> {
        todo!()
    }

    /// Stop every live (active/paused) goal on a thread. Currently called when a
    /// new goal supersedes the existing one (one active goal per thread).
    pub async fn stop_goals_for_thread(&self, thread_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Pause an active goal. `reason` defaults to `Paused by user.`
    pub async fn pause_goal(
        &self,
        goal_id: &str,
        reason: Option<&str>,
    ) -> anyhow::Result<Option<Goal>> {
        todo!()
    }

    pub async fn resume_goal(&self, goal_id: &str) -> anyhow::Result<Option<Goal>> {
        todo!()
    }

    // ========================================================================
    // Background continuation loop
    // ========================================================================

    fn signal_abort(&self, goal_id: &str) {
        if let Some(runtime) = self.runtimes.lock().get(goal_id) {
            runtime.aborted.store(true, Ordering::SeqCst);
            runtime.abort.cancel();
        }
    }

    /// Single owner of the `goal stopped` telemetry event — covers both a
    /// user-initiated stop and a goal superseded by a new one (`reason` is
    /// `user` or `replaced`). Logs the stop and emits the event; never the
    /// objective text (PII).
    fn record_stopped(&self, goal: &Goal, reason: &str) {
        todo!()
    }

    /// Run the goal's loop in the background; a crash is logged
    /// (`[Goal] Loop crashed for <id>`).
    fn start_loop(&self, goal_id: &str, after_restart: bool) {
        todo!()
    }

    /// Run turns until the goal is no longer active, a cap stops it, or the gate
    /// judges it complete. A still-running but *aborted* runtime is mid-teardown (a
    /// pause/stop landed during an in-flight invoke that hasn't returned yet), so it
    /// is replaced rather than left to drop the restart; the old loop's exit removes
    /// only its own runtime.
    async fn run_goal_loop(&self, goal_id: &str, after_restart: bool) -> anyhow::Result<()> {
        todo!()
    }

    /// Run a single goal turn under the per-thread lock and deliver its output.
    /// Returns `None` if aborted before the turn ran.
    async fn run_one_turn(
        &self,
        goal: &Goal,
        runtime: &Arc<GoalRuntime>,
    ) -> anyhow::Result<Option<GoalTurn>> {
        todo!()
    }

    /// Mark a goal terminal, persist the reason, and notify the user.
    async fn finalize(&self, goal: &Goal, status: &str, reason: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// What this goal's earlier turns sent, from its newest `GOAL_SEND_ROWS` stored
    /// turns. A goal turn reads no history, so this keeps a later turn from sending
    /// the same message again. The trade: a stored row names no goal, so a send of
    /// a goal this one replaced, stored after this one began, is read as this one's.
    async fn last_send_of(&self, goal: &Goal) -> Option<TaskLastSend> {
        todo!()
    }

    /// Deliver goal-turn output scoped to the originating channel.
    async fn deliver(
        &self,
        goal: &Goal,
        content: &str,
        tool_calls: Option<Vec<ToolCallRecord>>,
        attachment_ids: Option<Vec<String>>,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Completion gate — the sole completion signal. Fail → CONTINUE so a
    /// gate error can never prematurely complete a goal (the turn/stall caps bound
    /// the loop regardless).
    async fn should_declare_goal_complete(&self, objective: &str, latest_turn_text: &str) -> bool {
        todo!()
    }
}

impl Default for GoalService {
    fn default() -> Self {
        Self::new()
    }
}

pub static GOAL_SERVICE: LazyLock<GoalService> = LazyLock::new(GoalService::new);
