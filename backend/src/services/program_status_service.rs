//! Program Status Service
//!
//! Owns the agent's state as the runtime reports it on its stdout with OSC 7501
//! (`lib/program_status.rs`), so that a supervisor that reads the runtime's output,
//! such as LNS in a sandbox, can tell the user when the agent waits for them, has
//! finished or has failed. `PRISM_PROGRAM_STATUS` turns the reports on or off, and
//! without it the runtime reports when stdout is a terminal.
//!
//! A waiting computer help request wins over work, and work wins over how the last
//! work ended. Work is a turn on any thread, a conversation's whole exchange, a goal's
//! loop, and a compaction that is queued or running. When the work ends, the report is
//! `error` when a turn or an exchange failed, `idle` when one of them or a goal's loop was
//! cancelled, `done` when the agent delivered a reply, and `idle` otherwise: a heartbeat
//! or a scheduled task whose result was suppressed has nothing new to show.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use anyhow::anyhow;
use diesel::prelude::*;
use parking_lot::Mutex;
use serde_json::json;

use crate::config::CONFIG;
use crate::db::models::ConversationMessage;
use crate::db::schema::agent_workspaces::dsl as aw;
use crate::lib::log_redaction::err_json;
use crate::lib::program_status::{
    BlockedKind, CLEAR_SEQUENCE, ProgramStatus, program_status_sequence,
};
use crate::log_warn;
use crate::protocol::chat_protocol::{StreamEvent, TURN_FAILED, TurnEventPayload, TurnOutcome};
use crate::services::compaction_service::COMPACTION_SERVICE;
use crate::services::computer::computer_help_service::{COMPUTER_HELP_SERVICE, ComputerHelp};
use crate::services::computer::computer_service::COMPUTER_SERVICE;
use crate::services::conversation_thread_activity_service::CONVERSATION_THREAD_ACTIVITY_SERVICE;
use crate::services::event_stream_service::EVENT_STREAM_SERVICE;
use crate::services::message_delivery_service::MESSAGE_DELIVERY_SERVICE;

/// How a turn ended: the error a person reads when it failed, or that it was stopped.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnEnding {
    pub error: Option<String>,
    pub cancelled: Option<bool>,
}

/// How the current work, or the work that ended last, went.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Outcome {
    error: Option<String>,
    cancelled: bool,
    delivered: bool,
}

fn no_outcome() -> Outcome {
    Outcome::default()
}

/// What the agent is busy with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Work {
    Turn,
    Compaction,
}

/// A help request's card asks the user for something, which the waiting request reports.
fn is_help_card(message: &ConversationMessage) -> bool {
    let Some(serde_json::Value::Array(blocks)) = &message.blocks else {
        return false;
    };
    blocks
        .first()
        .and_then(|block| block.get("type"))
        .and_then(|kind| kind.as_str())
        == Some("computer_help")
}

/// The agent a started service reports for.
#[derive(Debug, Clone)]
struct ReportedAgent {
    id: String,
    user_id: String,
}

#[derive(Default)]
struct ProgramStatusState {
    agent: Option<ReportedAgent>,
    turns: i64,
    work: Option<Work>,
    outcome: Outcome,
    /// The help request that waits for the user and was listed last, as last read.
    help: Option<ComputerHelp>,
    help_changed: bool,
    written: Option<String>,
    /// One report is built at a time, and a change during the build schedules one
    /// more, so the last report written is the newest state.
    refreshing: bool,
    changed_again: bool,
}

pub struct ProgramStatusService {
    state: Mutex<ProgramStatusState>,
}

/// A turn marked as work by [`ProgramStatusService::begin_turn`]. `end` says how
/// the turn ended, once.
pub struct TurnHandle {
    ended: AtomicBool,
}

impl TurnHandle {
    /// Record how the turn ended. Only the first call counts.
    pub fn end(&self, ending: TurnEnding) {
        if self.ended.swap(true, Ordering::SeqCst) {
            return;
        }
        PROGRAM_STATUS_SERVICE.end_turn(ending);
    }
}

/// Writes the report that removes this program's records, as the process exits.
extern "C" fn write_clear_sequence() {
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(CLEAR_SEQUENCE.as_bytes());
    let _ = stdout.flush();
}

impl ProgramStatusService {
    pub fn new() -> Self {
        ProgramStatusService {
            state: Mutex::new(ProgramStatusState {
                help_changed: true,
                ..ProgramStatusState::default()
            }),
        }
    }

    /// Start reporting for the agent, when reports are on. Ends with `clear` at
    /// process exit.
    pub fn start(&'static self, agent_id: &str, user_id: &str) {
        {
            let mut state = self.state.lock();
            if !CONFIG.program_status_reports || state.agent.is_some() {
                return;
            }
            state.agent = Some(ReportedAgent {
                id: agent_id.to_string(),
                user_id: user_id.to_string(),
            });
        }
        CONVERSATION_THREAD_ACTIVITY_SERVICE
            .events
            .on_change(move |_| self.update());
        COMPACTION_SERVICE
            .events
            .on_compaction(move |_| self.update());
        COMPACTION_SERVICE.events.on_settled(move |_| self.update());
        let mut published = MESSAGE_DELIVERY_SERVICE.published.subscribe();
        tokio::spawn(async move {
            loop {
                match published.recv().await {
                    Ok(message) => {
                        if is_help_card(&message) {
                            continue;
                        }
                        self.state.lock().outcome.delivered = true;
                        self.update();
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        // A conversation's exchange can fail after its turns ended, when its reply cannot be stored.
        EVENT_STREAM_SERVICE.subscribe(Arc::new(move |entry| {
            if let StreamEvent::Turn(payload) = &entry.event.event {
                self.end_exchange(payload);
            }
        }));
        COMPUTER_SERVICE.on_change(Arc::new(move || {
            self.state.lock().help_changed = true;
            self.update();
        }));
        // SAFETY: `write_clear_sequence` is a plain function that lives for the whole
        // process; `exit` calls it once.
        unsafe {
            libc::atexit(write_clear_sequence);
        }
        self.update();
    }

    /// Mark a turn as work. The handle's `end` says how the turn ended, once.
    pub fn begin_turn(&self) -> TurnHandle {
        self.state.lock().turns += 1;
        self.update();
        TurnHandle {
            ended: AtomicBool::new(false),
        }
    }

    fn end_turn(&self, ending: TurnEnding) {
        {
            let mut state = self.state.lock();
            state.turns -= 1;
            if let Some(error) = ending.error.filter(|error| !error.is_empty()) {
                state.outcome.error = Some(error);
            }
            if ending.cancelled == Some(true) {
                state.outcome.cancelled = true;
            }
        }
        self.update();
    }

    fn end_exchange(&self, payload: &TurnEventPayload) {
        {
            let mut state = self.state.lock();
            match payload.outcome {
                Some(TurnOutcome::Failed) => {
                    state.outcome.error = Some(
                        payload
                            .error
                            .clone()
                            .unwrap_or_else(|| TURN_FAILED.to_string()),
                    );
                }
                Some(TurnOutcome::Cancelled) => state.outcome.cancelled = true,
                _ => return,
            }
        }
        self.update();
    }

    /// Follow the work at once, so that its start clears the last outcome, and
    /// report in the background.
    fn update(&self) {
        if self.state.lock().agent.is_none() {
            return;
        }
        // Read the other services before taking this one's lock: their listeners call
        // this function while they emit.
        let working_threads = !CONVERSATION_THREAD_ACTIVITY_SERVICE
            .working_thread_ids()
            .is_empty();
        let compacting = COMPACTION_SERVICE.has_in_flight();
        {
            let mut state = self.state.lock();
            let turning = state.turns > 0 || working_threads;
            let work = if turning {
                Some(Work::Turn)
            } else if compacting {
                Some(Work::Compaction)
            } else {
                None
            };
            if work.is_some() && state.work.is_none() {
                state.outcome = no_outcome();
            }
            state.work = work;
        }
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async { PROGRAM_STATUS_SERVICE.refresh().await });
        }
    }

    async fn refresh(&self) {
        {
            let mut state = self.state.lock();
            if state.refreshing {
                state.changed_again = true;
                return;
            }
            state.refreshing = true;
        }
        if let Err(err) = self.report().await {
            log_warn!(
                json!({ "err": err_json(&err) }),
                "[ProgramStatus] could not report the agent state"
            );
        }
        self.state.lock().refreshing = false;
    }

    /// Write the report for the state as it stands, again while it changed during the write.
    async fn report(&self) -> anyhow::Result<()> {
        loop {
            let agent = {
                let mut state = self.state.lock();
                state.changed_again = false;
                state
                    .agent
                    .clone()
                    .ok_or_else(|| anyhow!("no agent to report for"))?
            };
            // Read every time, so that a rename shows in the next report.
            let id = agent.id.clone();
            let name: String = crate::db::run(move |conn| {
                aw::agent_workspaces
                    .filter(aw::id.eq(&id))
                    .select(aw::name)
                    .first(conn)
                    .optional()?
                    .ok_or_else(|| anyhow!("No AgentWorkspace found"))
            })
            .await?;
            let help_changed = std::mem::take(&mut self.state.lock().help_changed);
            if help_changed {
                let help = COMPUTER_HELP_SERVICE
                    .waiting(&agent.id, &agent.user_id)
                    .await?
                    .pop();
                self.state.lock().help = help;
            }
            let sequence = program_status_sequence(&self.status(), &name);
            let fresh = {
                let mut state = self.state.lock();
                if state.written.as_deref() == Some(sequence.as_str()) {
                    false
                } else {
                    state.written = Some(sequence.clone());
                    true
                }
            };
            if fresh {
                let mut stdout = std::io::stdout();
                stdout.write_all(sequence.as_bytes())?;
                stdout.flush()?;
            }
            if !self.state.lock().changed_again {
                return Ok(());
            }
        }
    }

    fn status(&self) -> ProgramStatus {
        let state = self.state.lock();
        if let Some(help) = &state.help {
            return ProgramStatus::Blocked {
                kind: if help.credentials == Some(true) {
                    BlockedKind::Auth
                } else {
                    BlockedKind::Question
                },
                msg: help.reason.clone(),
            };
        }
        match state.work {
            Some(Work::Turn) => {
                return ProgramStatus::Working {
                    msg: "Thinking".into(),
                };
            }
            Some(Work::Compaction) => {
                return ProgramStatus::Working {
                    msg: "Compacting the conversation".into(),
                };
            }
            None => {}
        }
        if let Some(error) = state
            .outcome
            .error
            .as_ref()
            .filter(|error| !error.is_empty())
        {
            return ProgramStatus::Error { msg: error.clone() };
        }
        if state.outcome.cancelled {
            return ProgramStatus::Idle;
        }
        if state.outcome.delivered {
            return ProgramStatus::Done {
                msg: "Reply ready".into(),
            };
        }
        ProgramStatus::Idle
    }
}

impl Default for ProgramStatusService {
    fn default() -> Self {
        Self::new()
    }
}

pub static PROGRAM_STATUS_SERVICE: LazyLock<ProgramStatusService> =
    LazyLock::new(ProgramStatusService::new);

#[cfg(test)]
mod tests {
    use super::*;

    fn reporting() -> ProgramStatusService {
        let service = ProgramStatusService::new();
        service.state.lock().agent = Some(ReportedAgent {
            id: "agent-1".into(),
            user_id: "user-1".into(),
        });
        service
    }

    #[test]
    fn reports_work_over_the_outcome_of_the_last_work() {
        let service = reporting();
        service.state.lock().work = Some(Work::Turn);
        service.state.lock().outcome.error = Some("boom".into());
        assert_eq!(
            service.status(),
            ProgramStatus::Working {
                msg: "Thinking".into()
            }
        );
        service.state.lock().work = Some(Work::Compaction);
        assert_eq!(
            service.status(),
            ProgramStatus::Working {
                msg: "Compacting the conversation".into()
            }
        );
    }

    #[test]
    fn reports_how_the_last_work_ended() {
        let service = reporting();
        assert_eq!(service.status(), ProgramStatus::Idle);
        service.state.lock().outcome.delivered = true;
        assert_eq!(
            service.status(),
            ProgramStatus::Done {
                msg: "Reply ready".into()
            }
        );
        service.state.lock().outcome.cancelled = true;
        assert_eq!(service.status(), ProgramStatus::Idle);
        service.state.lock().outcome.error = Some("The agent could not answer.".into());
        assert_eq!(
            service.status(),
            ProgramStatus::Error {
                msg: "The agent could not answer.".into()
            }
        );
    }

    #[test]
    fn reports_a_failed_exchange_with_the_default_error() {
        let service = reporting();
        service.end_exchange(&TurnEventPayload {
            thread_id: "thread-1".into(),
            state: crate::protocol::chat_protocol::TurnState::Idle,
            outcome: Some(TurnOutcome::Failed),
            error: None,
            step: None,
        });
        assert_eq!(
            service.status(),
            ProgramStatus::Error {
                msg: TURN_FAILED.into()
            }
        );
    }

    #[test]
    fn reads_a_help_card_by_its_first_block() {
        let message = |blocks: serde_json::Value| ConversationMessage {
            id: "m".into(),
            thread_id: "t".into(),
            role: crate::db::models::MessageRole::Agent,
            content: String::new(),
            triggered_by: crate::db::models::MessageTrigger::UserInput,
            trigger_name: None,
            tool_calls: None,
            blocks: Some(blocks),
            sender_external_id: None,
            sender_name: None,
            external_message_id: None,
            is_compacted: false,
            internal_step: false,
            created_at: chrono::Utc::now(),
        };
        assert!(is_help_card(&message(json!([{ "type": "computer_help" }]))));
        assert!(!is_help_card(&message(json!([{ "type": "card" }]))));
        assert!(!is_help_card(&message(json!({ "type": "computer_help" }))));
    }
}
