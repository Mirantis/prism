import { describe, it, expect, vi } from 'vitest';
import { pollUntil } from './poll-until';

/**
 * A virtual clock: `sleep` advances it by the requested delay, so backoff and
 * the timeout budget are exercised deterministically without real timers.
 */
function virtualClock() {
  let nowMs = 0;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    sleeps,
  };
}

describe('pollUntil', () => {
  it('returns true immediately when the predicate succeeds on the first attempt', async () => {
    const clock = virtualClock();
    const predicate = vi.fn().mockResolvedValue(true);

    const result = await pollUntil(predicate, { now: clock.now, sleep: clock.sleep });

    expect(result).toBe(true);
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]); // never slept
  });

  it('retries with backoff until the predicate succeeds', async () => {
    const clock = virtualClock();
    const predicate = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    const result = await pollUntil(predicate, {
      now: clock.now,
      sleep: clock.sleep,
      baseDelayMs: 100,
      maxDelayMs: 4000,
      timeoutMs: 30_000,
    });

    expect(result).toBe(true);
    expect(predicate).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([100, 200]); // doubles between attempts
  });

  it('returns false once the time budget is exhausted', async () => {
    const clock = virtualClock();
    const predicate = vi.fn().mockResolvedValue(false);

    const result = await pollUntil(predicate, {
      now: clock.now,
      sleep: clock.sleep,
      baseDelayMs: 100,
      maxDelayMs: 400,
      timeoutMs: 1000,
    });

    expect(result).toBe(false);
    // 0 → s100 →100 → s200 →300 → s400 →700 → s400 →1100 (>=1000, stop)
    expect(clock.sleeps).toEqual([100, 200, 400, 400]);
    expect(predicate).toHaveBeenCalledTimes(5);
  });

  it('caps the backoff delay at maxDelayMs', async () => {
    const clock = virtualClock();
    const predicate = vi.fn().mockResolvedValue(false);

    await pollUntil(predicate, {
      now: clock.now,
      sleep: clock.sleep,
      baseDelayMs: 1000,
      maxDelayMs: 2000,
      timeoutMs: 10_000,
    });

    // 1000, then 2000 (capped), and stays capped thereafter
    expect(clock.sleeps.every((d) => d <= 2000)).toBe(true);
    expect(clock.sleeps).toContain(2000);
  });

  it('always attempts at least once even with a zero budget', async () => {
    const clock = virtualClock();
    const predicate = vi.fn().mockResolvedValue(false);

    const result = await pollUntil(predicate, { now: clock.now, sleep: clock.sleep, timeoutMs: 0 });

    expect(result).toBe(false);
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });
});
