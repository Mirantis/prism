//! Heartbeat schedule arithmetic.
//!
//! The heartbeat interval is measured from the last run, so the schedule
//! survives a restart: a process that boots with an overdue heartbeat runs it
//! promptly instead of waiting a full interval from the timer's creation.
//!
//! Pure functions, in their own module so they can be tested without the
//! service's dependency graph.

use chrono::{DateTime, Utc};

/// The smallest delay the scheduler arms. It equals the smallest interval the
/// write paths accept, so it can never stretch a legal schedule, and it caps a
/// restart loop at one heartbeat per minute.
pub const MIN_HEARTBEAT_DELAY_MS: i64 = 60_000;

/// The longest delay one timer is armed for. Node's timers hold a 32-bit delay,
/// so an interval past this is armed in steps of it; the steps keep the schedule
/// the same. Reachable, since the tool write path accepts any interval of
/// 60000ms or more.
pub const MAX_HEARTBEAT_DELAY_MS: i64 = 2_147_483_647;

/// When the next cycle is due, in epoch milliseconds.
///
/// A persisted deadline wins, so the next process arms what the last one had —
/// including a deadline a cadence change set, which no arithmetic over the last
/// run can reconstruct. Without one the deadline is one interval after the last
/// run, which is what a row written before the deadline was persisted holds. An
/// agent that has never run is not overdue, so it is due one full interval from
/// now.
///
/// A persisted deadline further out than one interval is trimmed to one interval
/// from now. Under the current cadence it cannot be right: it was written under a
/// longer one, by a cadence change made while the heartbeat was stopped, or the
/// clock has stepped back since. Trimming can only move a check earlier, and the
/// next cycle rewrites the column.
pub fn heartbeat_due_at(
    next_due: Option<DateTime<Utc>>,
    last_run: Option<DateTime<Utc>>,
    interval_ms: i64,
    now: i64,
) -> i64 {
    if let Some(next_due) = next_due {
        return next_due.timestamp_millis().min(now + interval_ms);
    }
    match last_run {
        Some(last_run) => last_run.timestamp_millis() + interval_ms,
        None => now + interval_ms,
    }
}

/// The delay to arm for a due time. A cycle already due waits the floor rather
/// than firing at once. A cycle still ahead waits the time remaining, capped at
/// one interval so a due time far ahead of the clock — a host resume, or a clock
/// stepped backwards after the last run was written — is re-checked within an
/// interval, and capped again at what one timer holds.
pub fn heartbeat_delay_ms(due_at: i64, interval_ms: i64, now: i64) -> i64 {
    let remaining = due_at - now;
    if remaining <= 0 {
        return MIN_HEARTBEAT_DELAY_MS;
    }
    remaining.min(interval_ms).min(MAX_HEARTBEAT_DELAY_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: i64) -> Option<DateTime<Utc>> {
        Some(crate::support::from_ms(ms))
    }

    const NOW: i64 = 1_736_942_400_000; // 2025-01-15T12:00:00Z
    const HOUR: i64 = 60 * 60 * 1000;
    const EIGHT_HOURS: i64 = 8 * HOUR;

    #[test]
    fn due_at_is_the_persisted_deadline_when_there_is_one() {
        assert_eq!(
            heartbeat_due_at(at(NOW + 2 * HOUR), at(NOW - 7 * HOUR), EIGHT_HOURS, NOW),
            NOW + 2 * HOUR
        );
    }

    #[test]
    fn due_at_is_the_persisted_deadline_even_when_it_is_already_past() {
        assert_eq!(
            heartbeat_due_at(at(NOW - HOUR), at(NOW), EIGHT_HOURS, NOW),
            NOW - HOUR
        );
    }

    #[test]
    fn due_at_trims_a_persisted_deadline_further_out_than_one_interval() {
        // A deadline written under the eight-hour cadence, read under a one-hour one.
        assert_eq!(
            heartbeat_due_at(at(NOW + EIGHT_HOURS), at(NOW), HOUR, NOW),
            NOW + HOUR
        );
    }

    #[test]
    fn due_at_is_one_interval_after_the_last_run_when_no_deadline_is_persisted() {
        assert_eq!(
            heartbeat_due_at(None, at(NOW - 5 * HOUR), EIGHT_HOURS, NOW),
            NOW + 3 * HOUR
        );
    }

    #[test]
    fn due_at_is_already_past_when_the_last_run_is_older_than_the_interval() {
        assert_eq!(
            heartbeat_due_at(None, at(NOW - 9 * HOUR), EIGHT_HOURS, NOW),
            NOW - HOUR
        );
    }

    #[test]
    fn due_at_is_one_interval_from_now_for_an_agent_that_has_never_run() {
        assert_eq!(
            heartbeat_due_at(None, None, EIGHT_HOURS, NOW),
            NOW + EIGHT_HOURS
        );
    }

    #[test]
    fn delay_waits_the_floor_when_the_cycle_is_overdue_or_due_now() {
        assert_eq!(
            heartbeat_delay_ms(NOW - HOUR, EIGHT_HOURS, NOW),
            MIN_HEARTBEAT_DELAY_MS
        );
        assert_eq!(
            heartbeat_delay_ms(NOW, EIGHT_HOURS, NOW),
            MIN_HEARTBEAT_DELAY_MS
        );
    }

    #[test]
    fn delay_waits_the_remainder_for_a_cycle_due_sooner_than_the_floor() {
        assert_eq!(heartbeat_delay_ms(NOW + 30_000, EIGHT_HOURS, NOW), 30_000);
    }

    #[test]
    fn delay_waits_the_remainder_for_a_cycle_due_within_the_interval() {
        assert_eq!(heartbeat_delay_ms(NOW + 3 * HOUR, EIGHT_HOURS, NOW), 3 * HOUR);
    }

    #[test]
    fn delay_waits_at_most_one_interval_when_the_due_time_is_ahead_of_the_clock() {
        assert_eq!(
            heartbeat_delay_ms(NOW + 20 * HOUR, EIGHT_HOURS, NOW),
            EIGHT_HOURS
        );
    }

    #[test]
    fn delay_never_arms_more_than_one_timer_holds() {
        let thirty_days = 30 * 24 * HOUR;
        assert_eq!(
            heartbeat_delay_ms(NOW + thirty_days, thirty_days, NOW),
            MAX_HEARTBEAT_DELAY_MS
        );
    }

    #[test]
    fn delay_arms_one_full_interval_for_an_agent_that_has_never_run() {
        let due_at = heartbeat_due_at(None, None, EIGHT_HOURS, NOW);
        assert_eq!(heartbeat_delay_ms(due_at, EIGHT_HOURS, NOW), EIGHT_HOURS);
    }

    #[test]
    fn delay_arms_the_remainder_of_a_persisted_deadline_a_cadence_change_shortened() {
        // Last run 05:00 on an eight-hour cadence, shortened to two hours at 12:00.
        let due_at = heartbeat_due_at(at(NOW + 2 * HOUR), at(NOW - 7 * HOUR), 2 * HOUR, NOW);
        assert_eq!(heartbeat_delay_ms(due_at, 2 * HOUR, NOW), 2 * HOUR);
    }
}
