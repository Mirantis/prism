/**
 * Google sign-in, and the redirect-settling it depends on.
 *
 * These moved here with the code: `settledUrl` exists because Google's post-login
 * redirect chain is slow and variable, and a flat sleep declared a signed-in profile
 * signed out — then ran a full interactive login against an already-authenticated
 * account. The browser stack no longer knows anything about it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isAuthenticated,
  sessionEvidence,
  settledUrl,
  signInFailureReason,
  signInToGoogle,
} from '../sign-in';
import { logger } from '../../../../../logger';

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

/**
 * A `waitForTimeout` that gives the event loop back, rather than only the microtask
 * queue. `settledUrl` polls against the real clock, so a stub resolving immediately
 * spins for the whole stability window and starves anything else on this worker.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

/**
 * A page that carries a login through: every control is visible, and pressing one
 * moves the URL to the account page.
 *
 * One stub for both form fields and both buttons, because the sequence is what is
 * under test and not which selector found what.
 */
function signInFormPage() {
  let landed = 'https://accounts.google.com/ServiceLogin?hl=en';
  const control = {
    waitFor: async () => {},
    click: async () => {
      landed = 'https://myaccount.google.com/';
    },
    type: async () => {},
    innerText: async () => '',
    first: () => control,
    or: () => control,
  };
  return {
    goto: vi.fn(async (url: string) => {
      if (url === 'about:blank') landed = 'about:blank';
    }),
    url: () => landed,
    waitForTimeout: tick,
    locator: () => control,
    getByRole: () => control,
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

    // Counted by destination, not in total: a failed attempt now parks the page on
    // about:blank before retrying, so the raw call count includes that too.
    const probes = goto.mock.calls.filter(([url]) =>
      String(url).startsWith('https://myaccount.google.com'),
    );
    expect(probes).toHaveLength(2);
    // Reused rather than re-entered: no sign-in form was ever asked for.
    expect(signInFailureReason()).toBeNull();
  });

  it('leaves the page still after a failed sign-in', async () => {
    // The failure this prevents is reported two steps later and names the wrong
    // thing: a join told the user their meeting link was interrupted by a Google
    // sign-in URL, because the abandoned redirect landed on top of it.
    config.googleBotEmail = 'bot@example.com';
    config.googleBotPassword = 'hunter2';
    const goto = vi.fn().mockRejectedValue(new Error('net::ERR_TUNNEL_CONNECTION_FAILED'));
    const page = { goto, url: () => 'https://www.google.com/', waitForTimeout: async () => {} };

    await signInToGoogle(page as never);

    const [lastUrl] = goto.mock.calls[goto.mock.calls.length - 1];
    expect(lastUrl).toBe('about:blank');
  });

  it('records the account session as live when the account page holds', async () => {
    // The reading the join gate needs, and the one a live deployment never got to
    // use: with it recorded, Meet offering a guest name field no longer costs the
    // session. Nothing is typed here — the session is reused as it stands.
    config.googleBotEmail = 'bot@example.com';
    config.googleBotPassword = 'hunter2';
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    const goto = vi.fn(async () => undefined);
    const page = {
      goto,
      url: () => 'https://myaccount.google.com/',
      waitForTimeout: tick,
    };

    await signInToGoogle(page as never);

    expect(sessionEvidence()).toEqual({
      live: true,
      signal: 'the account page stayed on myaccount.google.com',
    });
    expect(goto.mock.calls.map(String).join('\n')).not.toContain('ServiceLogin');
    // The two statements one start may not both make: reused, then signed in anyway.
    const said = info.mock.calls.map(String).join('\n');
    expect(said).toContain('Reusing the signed-in session');
    expect(said).not.toContain('Signing in:');
    info.mockRestore();
  });

  it('records where the account page landed when the session is refused', async () => {
    // A session Google will not accept has to be named, not merely acted on: the log
    // is where an operator tells a real refusal from a probe that was interrupted.
    config.googleBotEmail = 'bot@example.com';
    config.googleBotPassword = 'hunter2';
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    // No `locator`, so the login attempt below throws — this test is about the
    // reading that preceded it, and about the fact that it did attempt one.
    const goto = vi.fn(async () => undefined);
    const page = {
      goto,
      url: () => 'https://www.google.com/account/about',
      waitForTimeout: tick,
    };

    await signInToGoogle(page as never);

    expect(sessionEvidence()).toEqual({
      live: false,
      signal: 'the account page settled on https://www.google.com/account/about',
    });
    // It still signs in, which is the path a genuinely refused session depends on.
    expect(goto.mock.calls.map(String).join('\n')).toContain('ServiceLogin');
    expect(info.mock.calls.map(String).join('\n')).toContain(
      'Signing in: the account page settled on https://www.google.com/account/about',
    );
    info.mockRestore();
  });

  it('reports that the check could not complete when both attempts fail', async () => {
    // Not the same answer as "Google refused it", and the log must not claim it is.
    config.googleBotEmail = 'bot@example.com';
    config.googleBotPassword = 'hunter2';
    const goto = vi.fn().mockRejectedValue(new Error('net::ERR_TUNNEL_CONNECTION_FAILED'));
    const page = { goto, url: () => 'https://www.google.com/', waitForTimeout: tick };

    await signInToGoogle(page as never);

    expect(sessionEvidence()).toEqual({
      live: false,
      signal: 'the account session check could not complete',
    });
  });

  it('records the session established by a login', async () => {
    // What lets the second join succeed: after a forced sign-in the reading says the
    // session is live, so the retry is not gated off by the same guest field again.
    config.googleBotEmail = 'bot@example.com';
    config.googleBotPassword = 'hunter2';

    await signInToGoogle(signInFormPage() as never, { force: true });

    expect(sessionEvidence()).toEqual({
      live: true,
      signal: 'the account page stayed on myaccount.google.com',
    });
    expect(signInFailureReason()).toBeNull();
  });

  it("clears the previous call's verdict", async () => {
    // The module outlives a meeting. A live reading left over from the last call
    // would suppress the sign-in the next one needs.
    config.googleBotEmail = 'bot@example.com';
    config.googleBotPassword = 'hunter2';
    const live = {
      goto: vi.fn(async () => undefined),
      url: () => 'https://myaccount.google.com/',
      waitForTimeout: tick,
    };
    await signInToGoogle(live as never);
    expect(sessionEvidence()?.live).toBe(true);

    config.googleBotEmail = undefined;
    config.googleBotPassword = undefined;
    await signInToGoogle(live as never);

    expect(sessionEvidence()).toBeNull();
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
