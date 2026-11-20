//! Whether the agent has work in flight: what a restart would interrupt, and what
//! `GET /agents/state` reports as working.
//!
//! The updater had its own copy of this check, without the working threads. They
//! cover a message between its scheduling and its turn, a gap in which a restart
//! would only delay the turn, and which the updater now waits out too.

use crate::services::agent_status_service::AGENT_STATUS_SERVICE;
use crate::services::compaction_service::COMPACTION_SERVICE;
use crate::services::conversation_thread_activity_service::CONVERSATION_THREAD_ACTIVITY_SERVICE;
use crate::services::cron_scheduler_service::CRON_SCHEDULER_SERVICE;
use crate::services::goal_service::GOAL_SERVICE;
use crate::services::meeting::meeting_bot_service::MEETING_BOT_SERVICE;
use crate::services::thread_turn_service::THREAD_TURN_SERVICE;
use crate::services::voice::voice_chat_service::VOICE_CHAT_SERVICE;
use crate::tools::shell::agent_task_manager::get_agent_task_manager;
use crate::tools::shell::monitor_manager::get_monitor_manager;
use crate::tools::shell::process_manager::get_process_manager;

/// The in-process work the check reads, apart from the processes a tool started.
fn has_work_in_flight() -> bool {
    AGENT_STATUS_SERVICE.is_busy()
        || THREAD_TURN_SERVICE.has_live_exchange()
        || !CONVERSATION_THREAD_ACTIVITY_SERVICE
            .working_thread_ids()
            .is_empty()
        || MEETING_BOT_SERVICE.is_active()
        || CRON_SCHEDULER_SERVICE.has_running_task()
        || GOAL_SERVICE.has_live_loops()
        || COMPACTION_SERVICE.has_in_flight()
}

/// True when nothing runs and nothing waits for a turn.
///
/// `AGENT_STATUS_SERVICE.is_busy()` counts model invocations, which is not the
/// same as "the agent has nothing running". Three kinds of work fall outside it:
///
/// - a chat exchange, which spans the gap between a turn and the follow-up
///   coalesced after it, and holds its claim across that gap;
/// - a message that waits for its turn, whose thread is working from the
///   moment its turn is scheduled;
/// - a `shell_spawn` child or a `coding_agent` task, started by one tool call
///   and polled from later turns — killing one leaves the agent's next status
///   poll with nothing to report;
/// - a `monitor`, which waits for its command's output long after the turn
///   that started it.
///
/// Also false while the meeting bot is in a call, a cron task or a goal loop
/// runs, a compaction is in flight, or a voice chat is live.
pub async fn is_agent_idle() -> bool {
    if has_work_in_flight() {
        return false;
    }
    get_process_manager().running_count() == 0
        && get_agent_task_manager().running_count() == 0
        && get_monitor_manager().running_count() == 0
        && !VOICE_CHAT_SERVICE.is_live()
}
