/**
 * Heartbeat schedule arithmetic tests.
 *
 * Pure functions, so no clock and no service mocks: `now` is an argument.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_HEARTBEAT_DELAY_MS,
  MIN_HEARTBEAT_DELAY_MS,
  heartbeatDelayMs,
  heartbeatDueAt,
} from './heartbeat-schedule';

const NOW = Date.parse('2025-01-15T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const EIGHT_HOURS = 8 * HOUR;

describe('heartbeatDueAt', () => {
  it('is the persisted deadline when there is one', () => {
    const nextDue = new Date(NOW + 2 * HOUR);
    const lastRun = new Date(NOW - 7 * HOUR);

    expect(heartbeatDueAt(nextDue, lastRun, EIGHT_HOURS, NOW)).toBe(NOW + 2 * HOUR);
  });

  it('is the persisted deadline even when it is already past', () => {
    const nextDue = new Date(NOW - HOUR);

    expect(heartbeatDueAt(nextDue, new Date(NOW), EIGHT_HOURS, NOW)).toBe(NOW - HOUR);
  });

  it('trims a persisted deadline further out than one interval', () => {
    // A deadline written under the eight-hour cadence, read under a one-hour one.
    const nextDue = new Date(NOW + EIGHT_HOURS);

    expect(heartbeatDueAt(nextDue, new Date(NOW), HOUR, NOW)).toBe(NOW + HOUR);
  });

  it('is one interval after the last run when no deadline is persisted', () => {
    const lastRun = new Date(NOW - 5 * HOUR);

    expect(heartbeatDueAt(null, lastRun, EIGHT_HOURS, NOW)).toBe(NOW + 3 * HOUR);
  });

  it('is already past when the last run is older than the interval', () => {
    const lastRun = new Date(NOW - 9 * HOUR);

    expect(heartbeatDueAt(null, lastRun, EIGHT_HOURS, NOW)).toBe(NOW - HOUR);
  });

  it('is one interval from now for an agent that has never run', () => {
    expect(heartbeatDueAt(null, null, EIGHT_HOURS, NOW)).toBe(NOW + EIGHT_HOURS);
  });
});

describe('heartbeatDelayMs', () => {
  it('waits the floor when the cycle is overdue', () => {
    expect(heartbeatDelayMs(NOW - HOUR, EIGHT_HOURS, NOW)).toBe(MIN_HEARTBEAT_DELAY_MS);
  });

  it('waits the floor when the cycle is due exactly now', () => {
    expect(heartbeatDelayMs(NOW, EIGHT_HOURS, NOW)).toBe(MIN_HEARTBEAT_DELAY_MS);
  });

  it('waits the remainder for a cycle due sooner than the floor', () => {
    expect(heartbeatDelayMs(NOW + 30_000, EIGHT_HOURS, NOW)).toBe(30_000);
  });

  it('waits the remainder for a cycle due within the interval', () => {
    expect(heartbeatDelayMs(NOW + 3 * HOUR, EIGHT_HOURS, NOW)).toBe(3 * HOUR);
  });

  it('waits at most one interval when the due time is ahead of the clock', () => {
    expect(heartbeatDelayMs(NOW + 20 * HOUR, EIGHT_HOURS, NOW)).toBe(EIGHT_HOURS);
  });

  it('never arms a delay a timer cannot hold', () => {
    const thirtyDays = 30 * 24 * HOUR;

    expect(heartbeatDelayMs(NOW + thirtyDays, thirtyDays, NOW)).toBe(MAX_HEARTBEAT_DELAY_MS);
  });

  it('arms one full interval for an agent that has never run', () => {
    const dueAt = heartbeatDueAt(null, null, EIGHT_HOURS, NOW);

    expect(heartbeatDelayMs(dueAt, EIGHT_HOURS, NOW)).toBe(EIGHT_HOURS);
  });

  it('arms the remainder of a persisted deadline a cadence change shortened', () => {
    // Last run 05:00 on an eight-hour cadence, shortened to two hours at 12:00.
    const dueAt = heartbeatDueAt(new Date(NOW + 2 * HOUR), new Date(NOW - 7 * HOUR), 2 * HOUR, NOW);

    expect(heartbeatDelayMs(dueAt, 2 * HOUR, NOW)).toBe(2 * HOUR);
  });
});
