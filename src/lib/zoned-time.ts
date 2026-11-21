/**
 * Wall-clock arithmetic in an IANA time zone, with the zone's offset read from `Intl`
 * at the instant in question, so a daylight-saving change is handled.
 */

/** The wall-clock fields of `instant` in `timezone`. */
export function wallClock(
  instant: number,
  timezone: string,
): { year: number; month: number; day: number; utcMs: number } {
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
 * the offset in force at that time. Out-of-range fields roll over as in `Date.UTC`.
 */
export function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number): number => wallClock(instant, timezone).utcMs - Math.floor(instant / 1000) * 1000;
  const guess = asUtc - offsetAt(asUtc);
  return new Date(asUtc - offsetAt(guess));
}

/** True when `timezone` is an IANA zone name this runtime's `Intl` knows. */
export function isTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
