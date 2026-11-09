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
use std::time::Duration;

use anyhow::anyhow;
use chrono::Utc;
use diesel::prelude::*;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::ai::{GenerateTextOptions, ModelMessage};
use crate::config::CONFIG;
use crate::constants::{GOAL_MAX_OBJECTIVE_CHARS, GOAL_MAX_STALL_TURNS, GOAL_TURN_DELAY_MS};
use crate::db::models::{Goal, GoalChangeset, MessageRole, MessageTrigger, NewGoal};
use crate::db::schema::conversation_messages::dsl as m;
use crate::db::schema::goals::dsl as g;
use crate::db::sql_types::DbDateTime;
use crate::invoke::invoke;
use crate::lib::classification::get_gate_request;
use crate::lib::log_redaction::err_json;
use crate::lib::model_call::{ModelCallMeta, apply_telemetry, call_model};
use crate::lib::telemetry::{langfuse_telemetry, track_event};
use crate::prompts::context_builder::format_time_ago;
use crate::prompts::goal_prompt::{
    GOAL_COMPLETION_GATE_PROMPT, GoalPromptInput, build_goal_continuation_prompt,
};
use crate::services::channel_adapter_interface::{ChannelContext, ChannelName, ChatPlatform};
use crate::services::computer::computer_help_service::{COMPUTER_HELP_SERVICE, HelpStatus};
use crate::services::computer::supported::has_computer_for_mode;
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::services::conversation_thread_activity_service::{
    CONVERSATION_THREAD_ACTIVITY_SERVICE, ThreadMark,
};
use crate::services::llm_call_service::LlmCallPurpose;
use crate::services::message_delivery_service::{MESSAGE_DELIVERY_SERVICE, PublishOptions};
use crate::services::outbound_message_service::{
    OUTBOUND_MESSAGE_SERVICE, WithheldRun, sent_message_list,
};
use crate::services::program_status_service::{PROGRAM_STATUS_SERVICE, TurnEnding, TurnHandle};
use crate::services::thread_turn_service::THREAD_TURN_SERVICE;
use crate::support::js;
use crate::types::{InvokeErrorType, InvokeMode, InvokeRequest, TaskLastSend, ToolCallRecord};
use crate::{log_error, log_info, log_warn};

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

impl GoalRuntime {
    fn aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }
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

async fn find_goal(goal_id: &str) -> anyhow::Result<Option<Goal>> {
    let goal_id = goal_id.to_string();
    crate::db::run(move |conn| {
        Ok(g::goals
            .filter(g::id.eq(&goal_id))
            .select(Goal::as_select())
            .first(conn)
            .optional()?)
    })
    .await
}

/// Update one goal and answer the row as it now reads. Fails when no goal has the id.
async fn update_goal(goal_id: &str, changes: GoalChangeset) -> anyhow::Result<Goal> {
    let goal_id = goal_id.to_string();
    crate::db::run(move |conn| {
        let updated = diesel::update(g::goals.filter(g::id.eq(&goal_id)))
            .set(&changes)
            .execute(conn)?;
        if updated == 0 {
            return Err(anyhow!("Record to update not found."));
        }
        Ok(g::goals
            .filter(g::id.eq(&goal_id))
            .select(Goal::as_select())
            .first(conn)?)
    })
    .await
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
    pub async fn start_goal(&'static self, input: StartGoalInput) -> anyhow::Result<Goal> {
        let objective = js::trim(&input.objective).to_string();
        if objective.is_empty() {
            return Err(anyhow!("Goal objective is required"));
        }
        if js::len16(&objective) > GOAL_MAX_OBJECTIVE_CHARS {
            return Err(anyhow!(
                "Goal objective is too long (max {GOAL_MAX_OBJECTIVE_CHARS} characters)"
            ));
        }

        // Replace any live goal on this thread (one active per thread).
        self.stop_goals_for_thread(&input.thread_id).await?;

        let mut row = NewGoal::new(
            input.agent_id.clone(),
            input.user_id.clone(),
            input.thread_id.clone(),
            objective,
            CONFIG.goal_max_turns,
            input.origin_channel.clone(),
        );
        row.token_budget = input.token_budget.or(CONFIG.goal_default_token_budget);
        row.origin_channel_id = input.origin_channel_id.clone();
        let goal_id = row.id.clone();
        let goal = crate::db::run(move |conn| {
            diesel::insert_into(g::goals).values(&row).execute(conn)?;
            Ok(g::goals
                .filter(g::id.eq(&goal_id))
                .select(Goal::as_select())
                .first(conn)?)
        })
        .await?;

        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), input.agent_id.clone());
        props.insert("goal.id".to_string(), goal.id.clone());
        props.insert("goal.max_turns".to_string(), goal.max_turns.to_string());
        if let Some(budget) = goal.token_budget {
            props.insert("goal.token_budget".to_string(), budget.to_string());
        }
        track_event("goal started", Some(&input.user_id), Some(props));

        self.start_loop(&goal.id, false);
        Ok(goal)
    }

    /// Re-start loops for every active goal on boot (resets the stall counter).
    pub async fn restore_active_goals(&'static self, agent_id: &str) -> anyhow::Result<()> {
        let owner = agent_id.to_string();
        let goals = crate::db::run(move |conn| {
            Ok(g::goals
                .filter(g::agent_id.eq(&owner))
                .filter(g::status.eq("active"))
                .select(Goal::as_select())
                .load(conn)?)
        })
        .await?;
        for goal in &goals {
            update_goal(
                &goal.id,
                GoalChangeset {
                    stall_count: Some(0),
                    ..GoalChangeset::default()
                },
            )
            .await?;
            self.start_loop(&goal.id, true);
        }
        log_info!("[Goal] Restored {} active goal(s)", goals.len());
        Ok(())
    }

    /// Signal every running loop to stop after its current turn (graceful shutdown).
    pub fn stop_all(&self) {
        let runtimes: Vec<(String, Arc<GoalRuntime>)> = self
            .runtimes
            .lock()
            .iter()
            .map(|(id, runtime)| (id.clone(), Arc::clone(runtime)))
            .collect();
        for (goal_id, runtime) in &runtimes {
            runtime.aborted.store(true, Ordering::SeqCst);
            runtime.abort.cancel();
            log_info!("[Goal] {} loop signaled to stop (shutdown)", goal_id);
        }
        log_info!("[Goal] {} goal loop(s) signaled to stop", runtimes.len());
    }

    // ========================================================================
    // Queries + user-controlled state changes
    // ========================================================================

    /// The current live (active or paused) goal on a thread, if any.
    pub async fn get_goal_for_thread(&self, thread_id: &str) -> anyhow::Result<Option<Goal>> {
        let thread_id = thread_id.to_string();
        crate::db::run(move |conn| {
            Ok(g::goals
                .filter(g::thread_id.eq(&thread_id))
                .filter(g::status.eq_any(LIVE_STATUSES))
                .order(g::created_at.desc())
                .select(Goal::as_select())
                .first(conn)
                .optional()?)
        })
        .await
    }

    pub async fn get_goal_by_id(&self, goal_id: &str) -> anyhow::Result<Option<Goal>> {
        find_goal(goal_id).await
    }

    /// All goals for an agent, newest first (management/list view).
    pub async fn list_goals(&self, agent_id: &str) -> anyhow::Result<Vec<Goal>> {
        let agent_id = agent_id.to_string();
        crate::db::run(move |conn| {
            Ok(g::goals
                .filter(g::agent_id.eq(&agent_id))
                .order(g::created_at.desc())
                .select(Goal::as_select())
                .load(conn)?)
        })
        .await
    }

    /// Stop a goal by id; aborts its loop. No-op if already terminal.
    pub async fn stop_goal(&self, goal_id: &str) -> anyhow::Result<Option<Goal>> {
        self.signal_abort(goal_id);
        let Some(goal) = find_goal(goal_id).await? else {
            return Ok(None);
        };
        if !LIVE_STATUSES.contains(&goal.status.as_str()) {
            return Ok(Some(goal));
        }
        let stopped = update_goal(
            goal_id,
            GoalChangeset {
                status: Some("stopped".to_string()),
                last_reason: Some(Some("Stopped by user.".to_string())),
                completed_at: Some(Some(Utc::now())),
                ..GoalChangeset::default()
            },
        )
        .await?;
        self.record_stopped(&stopped, "user");
        Ok(Some(stopped))
    }

    /// Stop every live (active/paused) goal on a thread. Currently called when a
    /// new goal supersedes the existing one (one active goal per thread).
    pub async fn stop_goals_for_thread(&self, thread_id: &str) -> anyhow::Result<()> {
        let owner = thread_id.to_string();
        let goals = crate::db::run(move |conn| {
            Ok(g::goals
                .filter(g::thread_id.eq(&owner))
                .filter(g::status.eq_any(LIVE_STATUSES))
                .select(Goal::as_select())
                .load(conn)?)
        })
        .await?;
        if goals.is_empty() {
            return Ok(());
        }

        for goal in &goals {
            self.signal_abort(&goal.id);
            self.record_stopped(goal, "replaced");
        }

        let owner = thread_id.to_string();
        crate::db::run(move |conn| {
            diesel::update(
                g::goals
                    .filter(g::thread_id.eq(&owner))
                    .filter(g::status.eq_any(LIVE_STATUSES)),
            )
            .set(&GoalChangeset {
                status: Some("stopped".to_string()),
                last_reason: Some(Some("Replaced by a new goal.".to_string())),
                completed_at: Some(Some(Utc::now())),
                ..GoalChangeset::default()
            })
            .execute(conn)?;
            Ok(())
        })
        .await
    }

    /// Pause an active goal. `reason` defaults to `Paused by user.`
    pub async fn pause_goal(
        &self,
        goal_id: &str,
        reason: Option<&str>,
    ) -> anyhow::Result<Option<Goal>> {
        let reason = reason.unwrap_or("Paused by user.");
        self.signal_abort(goal_id);
        let goal = find_goal(goal_id).await?;
        let Some(goal) = goal.filter(|goal| goal.status == "active") else {
            return find_goal(goal_id).await;
        };
        let paused = update_goal(
            &goal.id,
            GoalChangeset {
                status: Some("paused".to_string()),
                last_reason: Some(Some(reason.to_string())),
                ..GoalChangeset::default()
            },
        )
        .await?;
        log_info!(
            "[Goal] {} paused by user after {} turn(s)",
            goal_id,
            paused.turn_count
        );
        track_event(
            "goal paused",
            Some(&paused.user_id),
            Some(IndexMap::from([
                ("agent.id".to_string(), paused.agent_id.clone()),
                ("goal.id".to_string(), paused.id.clone()),
                ("goal.turns".to_string(), paused.turn_count.to_string()),
            ])),
        );
        Ok(Some(paused))
    }

    pub async fn resume_goal(&'static self, goal_id: &str) -> anyhow::Result<Option<Goal>> {
        let goal = find_goal(goal_id).await?;
        let Some(goal) = goal else {
            return Ok(None);
        };
        if goal.status != "paused" {
            return Ok(Some(goal));
        }
        let updated = update_goal(
            goal_id,
            GoalChangeset {
                status: Some("active".to_string()),
                stall_count: Some(0),
                last_reason: Some(Some("Resumed by user.".to_string())),
                ..GoalChangeset::default()
            },
        )
        .await?;
        log_info!(
            "[Goal] {} resumed by user at turn {}/{}",
            goal_id,
            updated.turn_count,
            updated.max_turns
        );
        track_event(
            "goal resumed",
            Some(&updated.user_id),
            Some(IndexMap::from([
                ("agent.id".to_string(), updated.agent_id.clone()),
                ("goal.id".to_string(), updated.id.clone()),
                ("goal.turns".to_string(), updated.turn_count.to_string()),
            ])),
        );
        self.start_loop(goal_id, false);
        Ok(Some(updated))
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
        log_info!(
            "[Goal] {} stopped ({}) after {} turn(s), {} token(s)",
            goal.id,
            reason,
            goal.turn_count,
            goal.tokens_used
        );
        track_event(
            "goal stopped",
            Some(&goal.user_id),
            Some(IndexMap::from([
                ("agent.id".to_string(), goal.agent_id.clone()),
                ("goal.id".to_string(), goal.id.clone()),
                ("goal.reason".to_string(), reason.to_string()),
                ("goal.turns".to_string(), goal.turn_count.to_string()),
                ("goal.tokens".to_string(), goal.tokens_used.to_string()),
            ])),
        );
    }

    /// Run the goal's loop in the background; a crash is logged
    /// (`[Goal] Loop crashed for <id>`).
    fn start_loop(&'static self, goal_id: &str, after_restart: bool) {
        let goal_id = goal_id.to_string();
        tokio::spawn(async move {
            if let Err(err) = self.run_goal_loop(&goal_id, after_restart).await {
                log_error!(
                    json!({ "err": err_json(&err) }),
                    "[Goal] Loop crashed for {}",
                    goal_id
                );
            }
        });
    }

    /// Run turns until the goal is no longer active, a cap stops it, or the gate
    /// judges it complete. A still-running but *aborted* runtime is mid-teardown (a
    /// pause/stop landed during an in-flight invoke that hasn't returned yet), so it
    /// is replaced rather than left to drop the restart; the old loop's exit removes
    /// only its own runtime.
    async fn run_goal_loop(&self, goal_id: &str, after_restart: bool) -> anyhow::Result<()> {
        let runtime = {
            let mut runtimes = self.runtimes.lock();
            if let Some(existing) = runtimes.get(goal_id)
                && existing.is_running.load(Ordering::SeqCst)
                && !existing.aborted()
            {
                drop(runtimes);
                log_info!("[Goal] Loop already running for {}", goal_id);
                return Ok(());
            }
            let runtime = Arc::new(GoalRuntime {
                is_running: AtomicBool::new(true),
                aborted: AtomicBool::new(false),
                abort: CancellationToken::new(),
                after_restart: AtomicBool::new(after_restart),
            });
            runtimes.insert(goal_id.to_string(), Arc::clone(&runtime));
            runtime
        };
        // The thread works for the loop's whole life, the gate between two turns included.
        let mut end_activity = None;
        let mut loop_status = None;

        let result = self
            .loop_turns(goal_id, &runtime, &mut end_activity, &mut loop_status)
            .await;

        if let Some(mark) = end_activity {
            mark.end();
        }
        // A stop or a pause between two turns aborts no invoke, so the loop reports it.
        if let Some(status) = loop_status {
            status.end(TurnEnding {
                error: None,
                cancelled: Some(runtime.aborted()),
            });
        }
        runtime.is_running.store(false, Ordering::SeqCst);
        // Drop our entry so the map doesn't grow unbounded — but only if it's
        // still ours (a resume/replace may have installed a newer runtime).
        let mut runtimes = self.runtimes.lock();
        if runtimes
            .get(goal_id)
            .is_some_and(|current| Arc::ptr_eq(current, &runtime))
        {
            runtimes.remove(goal_id);
        }
        result
    }

    /// The turns of one loop, until it ends.
    async fn loop_turns(
        &self,
        goal_id: &str,
        runtime: &Arc<GoalRuntime>,
        end_activity: &mut Option<ThreadMark>,
        loop_status: &mut Option<TurnHandle>,
    ) -> anyhow::Result<()> {
        while !runtime.aborted() {
            // Re-load each iteration so user-driven stop/pause takes effect promptly.
            let goal = match find_goal(goal_id).await? {
                Some(goal) if goal.status == "active" => goal,
                other => {
                    let status = other.map_or_else(|| "deleted".to_string(), |goal| goal.status);
                    log_info!("[Goal] {} not active ({}) — stopping loop", goal_id, status);
                    return Ok(());
                }
            };
            // A turn reads the goal's own conversation. In single-thread mode another web
            // conversation is hidden and its answers go to the one conversation, so the turn
            // would not see what the last one did. The goal stops, and says so where clients look.
            if CONVERSATION_SERVICE
                .writable_thread_id(&goal.thread_id)
                .await?
                != goal.thread_id
            {
                self.finalize(
                    &goal,
                    "stopped",
                    "Its conversation is hidden in single-thread mode. Start the goal again here.",
                )
                .await?;
                return Ok(());
            }
            if end_activity.is_none() {
                *end_activity = Some(
                    CONVERSATION_THREAD_ACTIVITY_SERVICE
                        .begin_thread(&goal.thread_id, &goal.user_id),
                );
            }
            if loop_status.is_none() {
                *loop_status = Some(PROGRAM_STATUS_SERVICE.begin_turn());
            }

            // Hard caps, checked before spending another turn.
            if goal.turn_count >= goal.max_turns {
                self.finalize(
                    &goal,
                    "turn_limited",
                    &format!("Reached the {}-turn limit.", goal.max_turns),
                )
                .await?;
                return Ok(());
            }
            // Soft cap, not a hard ceiling: checked before a turn, so the turn that
            // crosses the budget runs to completion and only the next iteration
            // stops here. tokensUsed can therefore overshoot tokenBudget by up to
            // one full turn's spend.
            if let Some(budget) = goal.token_budget
                && goal.tokens_used >= budget
            {
                self.finalize(
                    &goal,
                    "budget_limited",
                    &format!("Reached the {budget}-token budget."),
                )
                .await?;
                return Ok(());
            }

            log_info!(
                "[Goal] {} starting turn {}/{}",
                goal_id,
                goal.turn_count + 1,
                goal.max_turns
            );

            let turn = self.run_one_turn(&goal, runtime).await?;
            if runtime.aborted() {
                return Ok(());
            }
            let Some(turn) = turn else {
                continue;
            };

            let new_tokens_used = goal.tokens_used + turn.tokens;
            let new_turn_count = goal.turn_count + 1;
            let counted = Goal {
                tokens_used: new_tokens_used,
                turn_count: new_turn_count,
                ..goal.clone()
            };

            // Account-level spending limit reached — stop and notify.
            if turn.budget_exceeded {
                log_info!(
                    "[Goal] {} stopping — account spending limit reached on turn {}",
                    goal_id,
                    new_turn_count
                );
                update_goal(
                    goal_id,
                    GoalChangeset {
                        tokens_used: Some(new_tokens_used),
                        turn_count: Some(new_turn_count),
                        ..GoalChangeset::default()
                    },
                )
                .await?;
                self.finalize(
                    &counted,
                    "budget_limited",
                    "Your organization's AI spending limit has been reached.",
                )
                .await?;
                return Ok(());
            }

            if has_computer_for_mode("goal")
                && COMPUTER_HELP_SERVICE
                    .list(&goal.agent_id, &goal.user_id, Some(&goal.thread_id))
                    .await?
                    .iter()
                    .any(|help| help.status == HelpStatus::Waiting)
            {
                update_goal(
                    &goal.id,
                    GoalChangeset {
                        tokens_used: Some(new_tokens_used),
                        turn_count: Some(new_turn_count),
                        last_reason: Some(Some("Waiting for computer help.".to_string())),
                        ..GoalChangeset::default()
                    },
                )
                .await?;
                self.pause_goal(&goal.id, Some("Waiting for computer help."))
                    .await?;
                return Ok(());
            }

            let complete = self
                .should_declare_goal_complete(&goal.objective, &turn.text)
                .await;

            let budget_label = goal
                .token_budget
                .filter(|budget| *budget != 0)
                .map(|budget| format!("/{budget}"))
                .unwrap_or_default();

            if complete {
                update_goal(
                    goal_id,
                    GoalChangeset {
                        tokens_used: Some(new_tokens_used),
                        turn_count: Some(new_turn_count),
                        stall_count: Some(0),
                        ..GoalChangeset::default()
                    },
                )
                .await?;
                log_info!(
                    "[Goal] {} turn {}/{} — gate=COMPLETE, tokens {}{}",
                    goal_id,
                    new_turn_count,
                    goal.max_turns,
                    new_tokens_used,
                    budget_label
                );
                self.finalize(&counted, "complete", "Objective achieved.")
                    .await?;
                return Ok(());
            }

            // Zero-progress turn = no tool calls. Two in a row → blocked.
            let new_stall = if turn.had_tool_calls {
                0
            } else {
                goal.stall_count + 1
            };
            update_goal(
                goal_id,
                GoalChangeset {
                    tokens_used: Some(new_tokens_used),
                    turn_count: Some(new_turn_count),
                    stall_count: Some(new_stall),
                    last_reason: Some(Some("In progress.".to_string())),
                    ..GoalChangeset::default()
                },
            )
            .await?;
            log_info!(
                "[Goal] {} turn {}/{} — gate=CONTINUE, tokens {}{}, toolCalls={}, stall={}/{}",
                goal_id,
                new_turn_count,
                goal.max_turns,
                new_tokens_used,
                budget_label,
                turn.had_tool_calls,
                new_stall,
                GOAL_MAX_STALL_TURNS
            );

            if new_stall >= GOAL_MAX_STALL_TURNS {
                self.finalize(
                    &counted,
                    "blocked",
                    &format!("No progress (no tool use) for {new_stall} consecutive turns."),
                )
                .await?;
                return Ok(());
            }

            if GOAL_TURN_DELAY_MS > 0 {
                tokio::time::sleep(Duration::from_millis(GOAL_TURN_DELAY_MS as u64)).await;
            }
        }
        Ok(())
    }

    /// Run a single goal turn under the per-thread lock and deliver its output.
    /// Returns `None` if aborted before the turn ran.
    async fn run_one_turn(
        &self,
        goal: &Goal,
        runtime: &Arc<GoalRuntime>,
    ) -> anyhow::Result<Option<GoalTurn>> {
        THREAD_TURN_SERVICE
            .run(&goal.thread_id, self.turn_in_lock(goal, runtime))
            .await
    }

    /// One goal turn, run while the goal holds its thread.
    async fn turn_in_lock(
        &self,
        goal: &Goal,
        runtime: &Arc<GoalRuntime>,
    ) -> anyhow::Result<Option<GoalTurn>> {
        if runtime.aborted() {
            return Ok(None);
        }

        let result = invoke(InvokeRequest {
            user_id: goal.user_id.clone(),
            agent_id: goal.agent_id.clone(),
            mode: InvokeMode::Goal,
            thread_id: Some(goal.thread_id.clone()),
            origin_channel: Some(goal_channel(goal)),
            origin_channel_id: goal.origin_channel_id.clone(),
            prompt: build_goal_continuation_prompt(&GoalPromptInput {
                objective: goal.objective.clone(),
                turn_count: goal.turn_count,
                max_turns: goal.max_turns,
                tokens_used: goal.tokens_used,
                token_budget: goal.token_budget,
            }),
            after_restart: runtime.after_restart.load(Ordering::SeqCst),
            abort_signal: Some(runtime.abort.clone()),
            last_send: self.last_send_of(goal).await,
            ..InvokeRequest::default()
        })
        .await?;
        runtime.after_restart.store(false, Ordering::SeqCst);
        let withheld = |content: String| WithheldRun {
            agent_id: goal.agent_id.clone(),
            user_id: goal.user_id.clone(),
            thread_id: Some(goal.thread_id.clone()),
            content,
            triggered_by: MessageTrigger::Goal,
            trigger_name: None,
            tool_calls: result.tool_calls.clone(),
        };
        // A stop or a shutdown ended the turn. It delivers nothing and is not counted,
        // so a goal a shutdown interrupted runs the turn again after the restart. A
        // message the turn sent stays in the goal's history, so the rerun reads it.
        if runtime.aborted() {
            let text = result
                .steps
                .last()
                .map(|step| js::trim(&step.text).to_string())
                .unwrap_or_default();
            OUTBOUND_MESSAGE_SERVICE
                .keep_withheld_run(withheld(text))
                .await?;
            return Ok(None);
        }

        let budget_exceeded = result
            .error
            .as_ref()
            .is_some_and(|error| error.kind == InvokeErrorType::BudgetExceeded);
        let text = match result.steps.last() {
            Some(step) => js::trim(&step.text).to_string(),
            None => js::trim(&result.response).to_string(),
        };

        // Deliver inside the lock so goal output and user messages stay ordered.
        if !budget_exceeded && !text.is_empty() {
            self.deliver(
                goal,
                &text,
                Some(result.tool_calls.clone()),
                result.attachment_ids.clone(),
            )
            .await?;
        } else {
            OUTBOUND_MESSAGE_SERVICE
                .keep_withheld_run(withheld(text.clone()))
                .await?;
        }

        Ok(Some(GoalTurn {
            text,
            tokens: result
                .usage
                .as_ref()
                .map(|usage| usage.total_tokens)
                .unwrap_or(0),
            had_tool_calls: !result.tool_calls.is_empty(),
            budget_exceeded,
        }))
    }

    /// Mark a goal terminal, persist the reason, and notify the user.
    async fn finalize(&self, goal: &Goal, status: &str, reason: &str) -> anyhow::Result<()> {
        let elapsed_ms = crate::support::now_ms() - goal.created_at.timestamp_millis();

        update_goal(
            &goal.id,
            GoalChangeset {
                status: Some(status.to_string()),
                last_reason: Some(Some(reason.to_string())),
                completed_at: Some(Some(Utc::now())),
                ..GoalChangeset::default()
            },
        )
        .await?;

        log_info!(
            "[Goal] {} finished: status={}, turns={}, tokens={}, elapsed={}ms — {}",
            goal.id,
            status,
            goal.turn_count,
            goal.tokens_used,
            elapsed_ms,
            reason
        );

        let label = match status {
            "complete" => "✅ Goal complete",
            "blocked" => "⚠️ Goal blocked",
            "turn_limited" => "⏹️ Goal stopped (turn limit reached)",
            "budget_limited" => "⏹️ Goal stopped (budget reached)",
            _ => "Goal ended",
        };

        // Deliver the terminal notice under the per-thread lock so it can't
        // interleave with an in-flight user chat turn's messages (the gate runs
        // between the last turn's delivery and here, outside the lock).
        let notice = format!("**{label}**\n\nObjective: {}\n\n{reason}", goal.objective);
        THREAD_TURN_SERVICE
            .run(&goal.thread_id, self.deliver(goal, &notice, None, None))
            .await?;

        // Single owner of the 'goal finished' event — fires for completion and for
        // error/cap stops (blocked, turn_limited, budget_limited). Carries the turn
        // count and elapsed wall-clock time; never the objective text (PII).
        track_event(
            "goal finished",
            Some(&goal.user_id),
            Some(IndexMap::from([
                ("agent.id".to_string(), goal.agent_id.clone()),
                ("goal.id".to_string(), goal.id.clone()),
                ("goal.status".to_string(), status.to_string()),
                ("goal.turns".to_string(), goal.turn_count.to_string()),
                ("goal.tokens".to_string(), goal.tokens_used.to_string()),
                ("goal.elapsed_ms".to_string(), elapsed_ms.to_string()),
            ])),
        );
        Ok(())
    }

    /// What this goal's earlier turns sent, from its newest `GOAL_SEND_ROWS` stored
    /// turns. A goal turn reads no history, so this keeps a later turn from sending
    /// the same message again. The trade: a stored row names no goal, so a send of
    /// a goal this one replaced, stored after this one began, is read as this one's.
    async fn last_send_of(&self, goal: &Goal) -> Option<TaskLastSend> {
        let thread_id = goal.thread_id.clone();
        let since = DbDateTime(goal.created_at);
        let rows = crate::db::run(move |conn| {
            Ok(m::conversation_messages
                .filter(m::thread_id.eq(&thread_id))
                .filter(m::role.eq(MessageRole::Agent))
                .filter(m::triggered_by.eq(MessageTrigger::Goal))
                .filter(m::created_at.ge(since))
                .order(m::created_at.desc())
                .limit(GOAL_SEND_ROWS)
                .select((m::created_at, m::tool_calls))
                .load::<(chrono::DateTime<Utc>, Option<Value>)>(conn)?)
        })
        .await;
        let rows = match rows {
            Ok(rows) => rows,
            Err(err) => {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[Goal] {} could not read its earlier sends",
                    goal.id
                );
                return None;
            }
        };
        let sends: Vec<(String, String, i64)> = rows
            .iter()
            .flat_map(|(created_at, tool_calls)| {
                let at = created_at.timestamp_millis();
                sent_message_list(&stored_tool_calls(tool_calls.as_ref()))
                    .into_iter()
                    .map(move |entry| (entry.place, entry.text, at))
            })
            .collect();
        let first_at = sends.first()?.2;
        Some(TaskLastSend {
            messages: sends
                .iter()
                .map(|(place, text, at)| format!("- To {place} ({}): {text}", format_time_ago(*at)))
                .collect::<Vec<_>>()
                .join("\n"),
            at: first_at,
            latest_report: None,
            reports: None,
        })
    }

    /// Deliver goal-turn output scoped to the originating channel.
    async fn deliver(
        &self,
        goal: &Goal,
        content: &str,
        tool_calls: Option<Vec<ToolCallRecord>>,
        attachment_ids: Option<Vec<String>>,
    ) -> anyhow::Result<()> {
        MESSAGE_DELIVERY_SERVICE
            .publish(
                &goal.user_id,
                &goal.thread_id,
                content,
                MessageTrigger::Goal,
                PublishOptions {
                    tool_calls: tool_calls.filter(|calls| !calls.is_empty()),
                    attachment_ids: attachment_ids.filter(|ids| !ids.is_empty()),
                    channel_context: Some(ChannelContext {
                        channel: goal_channel(goal),
                        channel_id: goal.origin_channel_id.clone(),
                        channel_thread_id: None,
                        thread_id: goal.thread_id.clone(),
                        include_feedback: None,
                    }),
                    ..PublishOptions::default()
                },
            )
            .await?;
        Ok(())
    }

    /// Completion gate — the sole completion signal. Fail → CONTINUE so a
    /// gate error can never prematurely complete a goal (the turn/stall caps bound
    /// the loop regardless).
    async fn should_declare_goal_complete(&self, objective: &str, latest_turn_text: &str) -> bool {
        if js::trim(latest_turn_text).is_empty() {
            return false;
        }

        let decided: anyhow::Result<bool> = async {
            let gate = get_gate_request()?;
            let mut params = GenerateTextOptions::new(gate.model);
            params.provider_options = Some(gate.provider_options);
            params.system = Some(GOAL_COMPLETION_GATE_PROMPT.into());
            params.messages = Some(vec![ModelMessage::user(format!(
                "## Objective\n{objective}\n\n## Agent's Latest Update\n{latest_turn_text}"
            ))]);
            // 16 is the OpenAI Responses API minimum (a cap — the verdict is one word).
            params.max_output_tokens = Some(16);
            params.temperature = gate.sampling_params.temperature;
            apply_telemetry(
                &mut params,
                langfuse_telemetry("goal-completion-gate", None, None),
            );
            let result = call_model(ModelCallMeta::new(LlmCallPurpose::GoalGate), params).await?;
            let text = result.text();
            let decision = js::trim(&text);
            let complete = decision.to_uppercase().starts_with("COMPLETE");
            log_info!("[Goal:Gate] Decision: {} (complete={})", decision, complete);
            Ok(complete)
        }
        .await;
        match decided {
            Ok(complete) => complete,
            Err(error) => {
                log_error!(
                    json!({ "err": err_json(&error) }),
                    "[Goal:Gate] Gate call failed, defaulting to CONTINUE"
                );
                false // fail → CONTINUE (never prematurely complete)
            }
        }
    }
}

impl Default for GoalService {
    fn default() -> Self {
        Self::new()
    }
}

pub static GOAL_SERVICE: LazyLock<GoalService> = LazyLock::new(GoalService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{NewAgentWorkspace, NewConversationThread};
    use crate::db::schema::agent_workspaces::dsl as aw;
    use crate::db::schema::conversation_threads::dsl as t;

    fn service() -> &'static GoalService {
        Box::leak(Box::new(GoalService::new()))
    }

    /// An agent and a thread to hold goals.
    async fn thread() -> (String, String) {
        let agent = NewAgentWorkspace::new("user-1", "soul", "user", "memory", "heartbeat", "");
        let agent_id = agent.id.clone();
        let thread = NewConversationThread::new(agent_id.clone(), "user-1");
        let thread_id = thread.id.clone();
        crate::db::run(move |conn| {
            diesel::insert_into(aw::agent_workspaces)
                .values(&agent)
                .execute(conn)?;
            diesel::insert_into(t::conversation_threads)
                .values(&thread)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        (agent_id, thread_id)
    }

    async fn insert_goal(agent_id: &str, thread_id: &str, status: &str) -> String {
        let mut row = NewGoal::new(agent_id, "user-1", thread_id, "Ship it", 10, "websocket");
        row.status = status.to_string();
        let id = row.id.clone();
        crate::db::run(move |conn| {
            diesel::insert_into(g::goals).values(&row).execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        id
    }

    #[tokio::test]
    async fn refuses_an_empty_or_too_long_objective() {
        let input = |objective: String| StartGoalInput {
            user_id: "user-1".into(),
            agent_id: "agent-1".into(),
            thread_id: "thread-1".into(),
            objective,
            token_budget: None,
            origin_channel: "websocket".into(),
            origin_channel_id: None,
        };
        let err = service().start_goal(input("   ".into())).await.unwrap_err();
        assert_eq!(err.to_string(), "Goal objective is required");
        let err = service()
            .start_goal(input("x".repeat(GOAL_MAX_OBJECTIVE_CHARS + 1)))
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            format!("Goal objective is too long (max {GOAL_MAX_OBJECTIVE_CHARS} characters)")
        );
    }

    #[test]
    fn delivers_to_the_channel_the_goal_was_started_in() {
        let goal = |channel: &str| Goal {
            id: "g".into(),
            agent_id: "a".into(),
            user_id: "u".into(),
            thread_id: "t".into(),
            objective: "o".into(),
            status: "active".into(),
            token_budget: None,
            tokens_used: 0,
            turn_count: 0,
            max_turns: 10,
            stall_count: 0,
            last_reason: None,
            origin_channel: channel.into(),
            origin_channel_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            completed_at: None,
        };
        assert_eq!(goal_channel(&goal("slack")), ChannelName::Slack);
        assert_eq!(goal_channel(&goal("websocket")), ChannelName::Websocket);
        assert_eq!(goal_channel(&goal("pigeon")), ChannelName::Websocket);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn stops_every_live_goal_on_a_thread_and_leaves_finished_ones() {
        let _db = crate::db::testing::test_db();
        let (agent_id, thread_id) = thread().await;
        let active = insert_goal(&agent_id, &thread_id, "active").await;
        let paused = insert_goal(&agent_id, &thread_id, "paused").await;
        let done = insert_goal(&agent_id, &thread_id, "complete").await;

        service().stop_goals_for_thread(&thread_id).await.unwrap();

        for id in [&active, &paused] {
            let goal = find_goal(id).await.unwrap().unwrap();
            assert_eq!(goal.status, "stopped");
            assert_eq!(goal.last_reason.as_deref(), Some("Replaced by a new goal."));
            assert!(goal.completed_at.is_some());
        }
        assert_eq!(find_goal(&done).await.unwrap().unwrap().status, "complete");
        assert_eq!(
            service().get_goal_for_thread(&thread_id).await.unwrap(),
            None
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn stops_a_live_goal_and_leaves_a_terminal_one_as_it_is() {
        let _db = crate::db::testing::test_db();
        let (agent_id, thread_id) = thread().await;
        let active = insert_goal(&agent_id, &thread_id, "active").await;
        let stopped = service().stop_goal(&active).await.unwrap().unwrap();
        assert_eq!(stopped.status, "stopped");
        assert_eq!(stopped.last_reason.as_deref(), Some("Stopped by user."));

        let done = insert_goal(&agent_id, &thread_id, "complete").await;
        assert_eq!(
            service().stop_goal(&done).await.unwrap().unwrap().status,
            "complete"
        );
        assert_eq!(service().stop_goal("nope").await.unwrap(), None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn pauses_only_an_active_goal() {
        let _db = crate::db::testing::test_db();
        let (agent_id, thread_id) = thread().await;
        let active = insert_goal(&agent_id, &thread_id, "active").await;
        let paused = service().pause_goal(&active, None).await.unwrap().unwrap();
        assert_eq!(paused.status, "paused");
        assert_eq!(paused.last_reason.as_deref(), Some("Paused by user."));
        // A paused goal stays as it is.
        let again = service()
            .pause_goal(&active, Some("Waiting for computer help."))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(again.last_reason.as_deref(), Some("Paused by user."));
        assert_eq!(
            service()
                .get_goal_for_thread(&thread_id)
                .await
                .unwrap()
                .unwrap()
                .id,
            active
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn lists_an_agents_goals_newest_first() {
        let _db = crate::db::testing::test_db();
        let (agent_id, thread_id) = thread().await;
        let first = insert_goal(&agent_id, &thread_id, "complete").await;
        tokio::time::sleep(Duration::from_millis(5)).await;
        let second = insert_goal(&agent_id, &thread_id, "stopped").await;
        let ids: Vec<String> = service()
            .list_goals(&agent_id)
            .await
            .unwrap()
            .into_iter()
            .map(|goal| goal.id)
            .collect();
        assert_eq!(ids, vec![second, first]);
    }

    #[tokio::test]
    async fn never_completes_a_goal_on_an_empty_update() {
        assert!(
            !service()
                .should_declare_goal_complete("Ship it", "   ")
                .await
        );
    }
}
