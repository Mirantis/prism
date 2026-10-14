/**
 * Scheduled-task schedule parsing.
 *
 * Pure, in its own module so the scheduler, the agent tools and the task routes
 * read a schedule the same way without importing each other.
 */

/**
 * Parse human-readable schedule into a cron expression.
 * Supports: "in X minutes", "at 3pm", "every 2 hours", "every hour", "every day",
 * "every day at 9am", raw cron.
 */
export function parseSchedule(schedule: string): {
  cronExpression: string;
  isOneShot: boolean;
  nextRunAt: Date | null;
} {
  const normalized = schedule.toLowerCase().trim();

  const inMatch = normalized.match(/^in\s+(\d+)\s+(second|seconds|sec|secs|minute|minutes|hour|hours|min|mins|hr|hrs)$/);
  if (inMatch) {
    const value = parseInt(inMatch[1]);
    const unit = inMatch[2];
    const ms = unit.startsWith('hour') || unit.startsWith('hr')
      ? value * 60 * 60 * 1000
      : unit.startsWith('sec')
        ? value * 1000
        : value * 60 * 1000;

    return {
      cronExpression: schedule,
      isOneShot: true,
      nextRunAt: new Date(Date.now() + ms),
    };
  }

  const atMatch = normalized.match(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (atMatch) {
    let hour = parseInt(atMatch[1]);
    const minute = atMatch[2] ? parseInt(atMatch[2]) : 0;
    const ampm = atMatch[3];

    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);

    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }

    return {
      cronExpression: schedule,
      isOneShot: true,
      nextRunAt: target,
    };
  }

  const everyMatch = normalized.match(/^every\s+(?:(\d+)\s+)?(second|seconds|sec|secs|minute|minutes|hour|hours|min|mins|hr|hrs)$/);
  if (everyMatch) {
    const value = everyMatch[1] ? parseInt(everyMatch[1]) : 1;
    const unit = everyMatch[2];

    if (unit.startsWith('sec')) {
      // node-cron supports a leading seconds field (6-field expression).
      return { cronExpression: `*/${value} * * * * *`, isOneShot: false, nextRunAt: null };
    }
    if (unit.startsWith('hour') || unit.startsWith('hr')) {
      return { cronExpression: `0 */${value} * * *`, isOneShot: false, nextRunAt: null };
    }
    return { cronExpression: `*/${value} * * * *`, isOneShot: false, nextRunAt: null };
  }

  if (normalized === 'every day') {
    return { cronExpression: '0 0 * * *', isOneShot: false, nextRunAt: null };
  }

  const dailyMatch = normalized.match(/^every\s+day\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1]);
    const minute = dailyMatch[2] ? parseInt(dailyMatch[2]) : 0;
    const ampm = dailyMatch[3];

    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    return { cronExpression: `${minute} ${hour} * * *`, isOneShot: false, nextRunAt: null };
  }

  return { cronExpression: schedule, isOneShot: false, nextRunAt: null };
}
