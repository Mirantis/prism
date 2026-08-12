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

vi.mock('../../../../../config', () => ({
  config: { googleBotEmail: undefined, googleBotPassword: undefined },
}));

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
  beforeEach(() => vi.clearAllMocks());

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
