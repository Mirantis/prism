import { describe, it, expect } from 'vitest';
import { describeSchedule } from './cron-presets';

describe('describeSchedule', () => {
  it('names a preset schedule, whatever its spacing', () => {
    expect(describeSchedule('0 9 * * 1-5')).toBe('Weekdays at 09:00');
    expect(describeSchedule(' 0  9 * *  *')).toBe('Every day at 09:00');
  });

  it('has no words for any other expression', () => {
    expect(describeSchedule('*/5 * * * *')).toBeNull();
  });
});
