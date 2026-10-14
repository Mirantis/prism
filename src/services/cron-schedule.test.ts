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
});
