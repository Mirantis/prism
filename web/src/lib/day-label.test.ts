import { describe, it, expect } from 'vitest';
import { dayLabel, isSameDay } from './day-label';

const now = new Date(2026, 8, 24, 15, 0);
const iso = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

describe('dayLabel', () => {
  it('names today and yesterday by the local calendar day', () => {
    expect(dayLabel(iso(2026, 8, 24, 0), now)).toBe('Today');
    expect(dayLabel(iso(2026, 8, 23, 23), now)).toBe('Yesterday');
  });

  it('names a day within the last week by its weekday', () => {
    expect(dayLabel(iso(2026, 8, 21), now)).toBe(new Date(2026, 8, 21).toLocaleDateString(undefined, { weekday: 'long' }));
  });

  it('gives the date for an older day, and the year only for another year', () => {
    expect(dayLabel(iso(2026, 7, 2), now)).toBe(
      new Date(2026, 7, 2).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }),
    );
    expect(dayLabel(iso(2025, 11, 31), now)).toContain('2025');
  });
});

describe('isSameDay', () => {
  it('compares local calendar days, not 24-hour spans', () => {
    expect(isSameDay(iso(2026, 8, 24, 0), iso(2026, 8, 24, 23))).toBe(true);
    expect(isSameDay(iso(2026, 8, 23, 23), iso(2026, 8, 24, 0))).toBe(false);
  });
});
