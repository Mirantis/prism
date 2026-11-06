//! Whether the agent has work in flight: what a restart would interrupt, and what
//! `GET /agents/state` reports as working.
//!
//! The updater had its own copy of this check, without the working threads. They
//! cover a message between its scheduling and its turn, a gap in which a restart
//! would only delay the turn, and which the updater now waits out too.

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
///   poll with nothing to report.
///
/// Also false while the meeting bot is in a call, a cron task or a goal loop
/// runs, a compaction is in flight, or a voice chat is live.
pub async fn is_agent_idle() -> bool {
    todo!()
}
