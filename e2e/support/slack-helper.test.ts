/**
 * `pollUntil` decides how long every Slack wait lasts and which failures end
 * one, and neither is observable from a suite that needs real credentials.
 * Real timers with tens-of-millisecond budgets: the assertions are about
 * ordering and outcome.
 */

import { describe, expect, it, vi } from 'vitest';
import { pollUntil } from './slack-helper';

/** A rejection shaped like the SDK's `WebAPIPlatformError`. */
function platformError(reason: string): Error & { code: string; data: { error: string } } {
  return Object.assign(new Error(`slack: ${reason}`), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: reason },
  });
}

describe('pollUntil', () => {
  it('returns the first result an attempt reports', async () => {
    const attempt = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('found');
    await expect(
      pollUntil(attempt, { timeoutMs: 2_000, intervalMs: 1, label: 'probe' }),
    ).resolves.toBe('found');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('gives up at the deadline rather than hanging on an attempt that never settles', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const started = Date.now();
    await expect(
      pollUntil(() => new Promise(() => undefined), { timeoutMs: 100, intervalMs: 10, label: 'hung' }),
    ).resolves.toBeNull();
    // The point is that it returns at all; the bound only has to be loose
    // enough not to fail on a busy machine.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('retries a transport failure and still succeeds', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce('recovered');
    await expect(
      pollUntil(attempt, { timeoutMs: 2_000, intervalMs: 1, label: 'transport' }),
    ).resolves.toBe('recovered');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('raises a refusal Slack named, instead of polling through it', async () => {
    const attempt = vi.fn().mockRejectedValue(platformError('invalid_auth'));
    await expect(
      pollUntil(attempt, { timeoutMs: 2_000, intervalMs: 1, label: 'fatal' }),
    ).rejects.toThrow(/invalid_auth/);
    // Raised on the first attempt: another identical call cannot be accepted.
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying a rate limit, which is the one refusal worth repeating', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(platformError('ratelimited'))
      .mockResolvedValueOnce('through');
    await expect(
      pollUntil(attempt, { timeoutMs: 2_000, intervalMs: 1, label: 'ratelimited' }),
    ).resolves.toBe('through');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does not leave an unhandled rejection behind when it abandons an attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // Rejects well after the wait has given up, which is the case that used
      // to surface as an unhandled rejection and redden an otherwise green run.
      await pollUntil(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 80)),
        { timeoutMs: 20, intervalMs: 5, label: 'abandoned' },
      );
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});
