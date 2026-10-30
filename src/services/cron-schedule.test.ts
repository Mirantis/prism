import { describe, it, expect } from 'vitest';
import * as nodeCron from 'node-cron';
import { parseSchedule } from './cron-schedule';

describe('parseSchedule', () => {
  it('parses "in N seconds" as a one-shot', () => {
    const { isOneShot, nextRunAt } = parseSchedule('in 30 seconds');
    expect(isOneShot).toBe(true);
    expect(nextRunAt).toBeInstanceOf(Date);
  });

  it('parses "every N seconds" as a recurring 6-field cron expression', () => {
    const { isOneShot, cronExpression, nextRunAt } = parseSchedule('every 15 seconds');
    expect(isOneShot).toBe(false);
    expect(cronExpression).toBe('*/15 * * * * *');
    expect(nextRunAt).toBeNull();
  });

  it('still parses minutes one-shot / recurring', () => {
    expect(parseSchedule('in 5 minutes').isOneShot).toBe(true);
    expect(parseSchedule('every 2 hours').isOneShot).toBe(false);
  });

  // docs/scheduled-tasks.md tells users they can say "every hour".
  it('parses a bare unit as an interval of one', () => {
    for (const [phrase, expression] of [
      ['every hour', '0 */1 * * *'],
      ['every minute', '*/1 * * * *'],
      ['every second', '*/1 * * * * *'],
      ['every day', '0 0 * * *'],
    ]) {
      const { isOneShot, cronExpression } = parseSchedule(phrase);
      expect(isOneShot, phrase).toBe(false);
      expect(cronExpression, phrase).toBe(expression);
      expect(nodeCron.validate(cronExpression), phrase).toBe(true);
    }
  });

  describe('"at H[:MM]" in the agent\'s time zone', () => {
    const at = (schedule: string, timezone: string, now: string): string | undefined =>
      parseSchedule(schedule, { timezone, now: new Date(now) }).nextRunAt?.toISOString();

    it('runs when the zone\'s clock shows the time, whatever zone the process is in', () => {
      // 12:00 in Helsinki (UTC+2), so 3pm is later the same day.
      expect(at('at 3pm', 'Europe/Helsinki', '2026-10-30T10:00:00Z')).toBe('2026-10-30T13:00:00.000Z');
      expect(at('at 9:30am', 'America/New_York', '2026-10-30T12:00:00Z')).toBe('2026-10-30T13:30:00.000Z');
    });

    it('moves to the next day when the time has passed in the zone', () => {
      // 16:00 in Helsinki.
      expect(at('at 3pm', 'Europe/Helsinki', '2026-10-30T14:00:00Z')).toBe('2026-10-31T13:00:00.000Z');
    });

    it('takes the date from the zone, not from UTC', () => {
      // 00:30 on Oct 31 in Helsinki, while UTC is still on Oct 30.
      expect(at('at 1am', 'Europe/Helsinki', '2026-10-30T22:30:00Z')).toBe('2026-10-30T23:00:00.000Z');
    });

    it('uses the offset in force at the run time on a daylight-saving change day', () => {
      // 23:00 on Oct 24 in Helsinki (UTC+3). The clocks go back to UTC+2 at 04:00 on Oct 25.
      expect(at('at 9am', 'Europe/Helsinki', '2026-10-24T20:00:00Z')).toBe('2026-10-25T07:00:00.000Z');
    });
  });
});
