/**
 * Heartbeat schedule arithmetic.
 *
 * The heartbeat interval is measured from the last run, so the schedule
 * survives a restart: a process that boots with an overdue heartbeat runs it
 * promptly instead of waiting a full interval from the timer's creation.
 *
 * Pure functions, in their own module so they can be tested without the
 * service's dependency graph.
 */

/**
 * The smallest delay the scheduler arms. It equals the smallest interval the
 * write paths accept, so it can never stretch a legal schedule, and it caps a
 * restart loop at one heartbeat per minute.
 */
export const MIN_HEARTBEAT_DELAY_MS = 60_000;

/**
 * Node's timers hold a 32-bit delay. A longer one overflows and fires at once,
 * so an interval past this is armed in steps of it instead. Reachable, since the
 * tool write path accepts any interval of 60000ms or more.
 */
export const MAX_HEARTBEAT_DELAY_MS = 2_147_483_647;

/**
 * When the next cycle is due.
 *
 * A persisted deadline wins, so the next process arms what the last one had —
 * including a deadline a cadence change set, which no arithmetic over the last
 * run can reconstruct. Without one the deadline is one interval after the last
 * run, which is what a row written before the deadline was persisted holds. An
 * agent that has never run is not overdue, so it is due one full interval from
 * now.
 *
 * A persisted deadline further out than one interval is trimmed to one interval
 * from now. Under the current cadence it cannot be right: it was written under a
 * longer one, by a cadence change made while the heartbeat was stopped, or the
 * clock has stepped back since. Trimming can only move a check earlier, and the
 * next cycle rewrites the column.
 */
export function heartbeatDueAt(
  nextDue: Date | null,
  lastRun: Date | null,
  intervalMs: number,
  now: number,
): number {
  if (nextDue) return Math.min(nextDue.getTime(), now + intervalMs);
  return lastRun ? lastRun.getTime() + intervalMs : now + intervalMs;
}

/**
 * The delay to arm for a due time. A cycle already due waits the floor rather
 * than firing at once. A cycle still ahead waits the time remaining, capped at
 * one interval so a due time far ahead of the clock — a host resume, or a clock
 * stepped backwards after the last run was written — is re-checked within an
 * interval, and capped again at what a timer can hold.
 */
export function heartbeatDelayMs(dueAt: number, intervalMs: number, now: number): number {
  const remaining = dueAt - now;
  if (remaining <= 0) return MIN_HEARTBEAT_DELAY_MS;
  return Math.min(remaining, intervalMs, MAX_HEARTBEAT_DELAY_MS);
}
