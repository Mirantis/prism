/**
 * Scheduled-task schedule parsing.
 *
 * Pure, in its own module so the scheduler, the agent tools and the task routes
 * read a schedule the same way without importing each other.
 */

/** The wall-clock fields of `instant` in `timezone`. */
function wallClock(instant: number, timezone: string): { year: number; month: number; day: number; utcMs: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instant));
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)!.value);
  const [year, month, day] = [field('year'), field('month'), field('day')];
  return { year, month, day, utcMs: Date.UTC(year, month - 1, day, field('hour'), field('minute'), field('second')) };
}

/**
 * The instant at which `timezone` shows the given date and time. The zone's offset is read
 * at a first guess and again at the result, so a time on a daylight-saving change day gets
 * the offset in force at that time.
 */
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number): number => wallClock(instant, timezone).utcMs - Math.floor(instant / 1000) * 1000;
  const guess = asUtc - offsetAt(asUtc);
  return new Date(asUtc - offsetAt(guess));
}

/**
 * Parse human-readable schedule into a cron expression.
 * Supports: "in X minutes", "at 3pm", "every 2 hours", "every hour", "every day",
 * "every day at 9am", raw cron. "at 3pm" is read in `timezone`, an IANA name: the next
 * time that zone's clock shows 3pm.
 */
export function parseSchedule(
  schedule: string,
  { timezone = 'UTC', now = new Date() }: { timezone?: string; now?: Date } = {},
): {
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
      nextRunAt: new Date(now.getTime() + ms),
    };
  }

  const atMatch = normalized.match(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (atMatch) {
    let hour = parseInt(atMatch[1]);
    const minute = atMatch[2] ? parseInt(atMatch[2]) : 0;
    const ampm = atMatch[3];

    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const today = wallClock(now.getTime(), timezone);
    let target = zonedInstant(today.year, today.month, today.day, hour, minute, timezone);
    if (target <= now) {
      target = zonedInstant(today.year, today.month, today.day + 1, hour, minute, timezone);
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
