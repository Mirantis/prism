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

use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;

use crate::db::models::ConversationMessage;
use crate::lib::program_status::ProgramStatus;
use crate::protocol::chat_protocol::TurnEventPayload;
use crate::services::computer::computer_help_service::ComputerHelp;

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
    todo!()
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
    pub fn start(&self, agent_id: &str, user_id: &str) {
        todo!()
    }

    /// Mark a turn as work. The handle's `end` says how the turn ended, once.
    pub fn begin_turn(&self) -> TurnHandle {
        todo!()
    }

    fn end_turn(&self, ending: TurnEnding) {
        todo!()
    }

    fn end_exchange(&self, payload: &TurnEventPayload) {
        todo!()
    }

    /// Follow the work at once, so that its start clears the last outcome, and
    /// report in the background.
    fn update(&self) {
        todo!()
    }

    async fn refresh(&self) {
        todo!()
    }

    fn status(&self) -> ProgramStatus {
        todo!()
    }
}

impl Default for ProgramStatusService {
    fn default() -> Self {
        Self::new()
    }
}

pub static PROGRAM_STATUS_SERVICE: LazyLock<ProgramStatusService> =
    LazyLock::new(ProgramStatusService::new);
