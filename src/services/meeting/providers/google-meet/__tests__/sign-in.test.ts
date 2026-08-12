/**
 * Google sign-in, and the redirect-settling it depends on.
 *
 * These moved here with the code: `settledUrl` exists because Google's post-login
 * redirect chain is slow and variable, and a flat sleep declared a signed-in profile
 * signed out — then ran a full interactive login against an already-authenticated
 * account. The browser stack no longer knows anything about it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isAuthenticated, settledUrl, signInFailureReason, signInToGoogle } from '../sign-in';

// Mutable so a test can put credentials in place: `isAuthenticated()` reads them
// directly now, rather than reporting what a probe concluded.
// `vi.hoisted` because the factory below is hoisted above this file's own
// declarations, so a plain const would not exist yet when it runs.
const config = vi.hoisted(() => ({
  googleBotEmail: undefined as string | undefined,
  googleBotPassword: undefined as string | undefined,
}));
vi.mock('../../../../../config', () => ({ config }));

function redirectingPage(chain: string[]) {
  let step = 0;
  return {
    url: () => chain[Math.min(step, chain.length - 1)],
    waitForTimeout: async () => {
      step += 1;
      await new Promise((r) => setTimeout(r, 1));
    },
  };
}

describe('settledUrl', () => {
  it('reports where a redirect chain came to rest, not where it was mid-flight', async () => {
    // The whole point: reading the URL while Google is still bouncing between
    // accounts.google.com and myaccount.google.com is what made an intermittently
    // slow chain look like a signed-out profile.
    const page = redirectingPage([
      'https://accounts.google.com/ServiceLogin',
      'https://accounts.google.com/CheckCookie',
      'https://myaccount.google.com/',
    ]);

    expect(await settledUrl(page, 5_000, 1)).toBe('https://myaccount.google.com/');
  });

  it('still resolves a chain slower than the old two-second sleep', async () => {
    // The regression this exists for. Nine hops at 250 ms each is well past 2 s, and
    // under the old flat sleep this profile was declared signed out — triggering a
    // full interactive login against an account that was already authenticated.
    const chain = Array.from({ length: 9 }, (_, i) => `https://accounts.google.com/hop-${i}`);
    const page = redirectingPage([...chain, 'https://myaccount.google.com/']);

    expect(await settledUrl(page, 30_000, 1)).toBe('https://myaccount.google.com/');
  });

  it('detects a settled signed-out landing without waiting out the timeout', async () => {
    const page = redirectingPage(['https://www.google.com/account/about']);
    const startedAt = Date.now();

    const url = await settledUrl(page, 30_000, 1);

    expect(url).toBe('https://www.google.com/account/about');
    // Must not have burned the full budget on a page that never moves.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('gives up at the deadline rather than hanging on a chain that never settles', async () => {
    // A page that redirects forever must still produce an answer; the caller treats
    // "not myaccount" as not signed in, which is the safe direction.
    let step = 0;
    const page = {
      url: () => `https://accounts.google.com/step-${step}`,
      waitForTimeout: async () => {
        step += 1;
        await new Promise((r) => setTimeout(r, 1));
      },
    };

    await expect(settledUrl(page, 100, 10_000)).resolves.toMatch(/accounts\.google\.com/);
  });
});

describe('sign-in state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.googleBotEmail = undefined;
    config.googleBotPassword = undefined;
  });

  it('counts a configured account as authenticated, without probing for it', () => {
    // The question this answers is "should a guest name field be read as a stale
    // session?", and for that, intent is the right test. Confirming it by probing
    // failed in the direction that costs joins: a probe that says no *disables* the
    // stale-session path, so the join walks into the lobby and Meet auto-denies it.
    config.googleBotEmail = 'bot@example.com';
    config.googleBotPassword = 'hunter2';

    expect(isAuthenticated()).toBe(true);
  });

  it('reuses a session whose first check was interrupted mid-redirect', async () => {
    // Watched live: Google's own redirect chain interrupted the check's navigation,
    // it rejected, and a perfectly live session was reported as signed out — while
    // the account page it had just loaded was on screen. One retry is the difference
    // between reusing the session and running a needless full login.
    config.googleBotEmail = 'bot@example.com';
    config.googleBotPassword = 'hunter2';
    const goto = vi
      .fn()
      .mockRejectedValueOnce(new Error('net::ERR_ABORTED; navigation interrupted'))
      .mockResolvedValueOnce(undefined);
    const page = {
      goto,
      url: () => 'https://myaccount.google.com/',
      waitForTimeout: async () => {},
    };

    await signInToGoogle(page as never);

    expect(goto).toHaveBeenCalledTimes(2);
    // Reused rather than re-entered: no sign-in form was ever asked for.
    expect(signInFailureReason()).toBeNull();
  });

  it('is not authenticated with no account configured', async () => {
    // The provider is a module singleton, so this state outlives a meeting. A
    // failure from one call must not annotate the next call's denial, and a stale
    // `authenticated` must not decide that this call's session is fine.
    const page = { goto: vi.fn(), url: () => 'about:blank', waitForTimeout: vi.fn() };

    await signInToGoogle(page as never);

    expect(isAuthenticated()).toBe(false);
    expect(signInFailureReason()).toBeNull();
    // No credentials: it should not have tried to navigate anywhere.
    expect(page.goto).not.toHaveBeenCalled();
  });
});
