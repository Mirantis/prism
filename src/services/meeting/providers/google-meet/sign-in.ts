/**
 * Signing the browser into a Google account.
 *
 * Lives with the provider rather than with the browser stack because it is the one
 * thing about a meeting browser that is platform-specific: a Teams or Zoom provider
 * authenticates differently, or not at all. What the browser stack owns is a real
 * browser on a virtual display with a persistent profile — the session this module
 * establishes is stored in that profile, which is why the two are related but not
 * the same concern.
 *
 * Signing in is not a nicety. Meet **auto-denies automated anonymous guests**
 * (`CreateMeetingDevice` 403, with the host never prompted), so a bot that isn't
 * signed in reaches the lobby and never gets further.
 *
 * **Nothing here throws.** Failure is deliberately non-fatal: whether the browser is
 * signed in is decided by the profile's cookies, not by anything recorded here, and
 * this check has been observed reporting a challenge for a session that then joined
 * a call perfectly well. Refusing to join on a failed login would refuse joins that
 * would have worked. The reason is recorded instead, and named in the denial if one
 * follows.
 */

// Type-only, matching `browser-stack.ts`: `playwright-core` is external to the SEA
// bundle, so a *value* import here would be evaluated at startup — before
// `isBrowserAvailable()` can decide the host has no browser at all.
import type { Locator, Page } from 'playwright-core';
import { config } from '../../../../config';
import { logger } from '../../../../logger';

/**
 * How long to let Google's redirect chain settle before judging the session, and how
 * long the URL must hold still to count as settled.
 */
const SESSION_SETTLE_TIMEOUT_MS = 15_000;
const SESSION_STABLE_MS = 1_000;

/**
 * Whether this profile is signed in, and why not if it isn't.
 *
 * Module-level because the provider it serves is a module singleton, and reset on
 * every `signInToGoogle` call: the alternative is a failure from one meeting
 * annotating the next meeting's denial, or a stale `authenticated` from an hour ago
 * deciding that this call's session is fine.
 */
const state: { authenticated: boolean; signInFailure: string | null } = {
  authenticated: false,
  signInFailure: null,
};

/** Whether the profile ended up signed into a Google account. */
export function isAuthenticated(): boolean {
  return state.authenticated;
}

/**
 * Why signing in failed, when an account was configured — otherwise null.
 *
 * Exists so a downstream refusal can name its real cause. Meet hides "we refuse
 * automated anonymous guests" behind the same wall it shows for an ended meeting,
 * and the runtime knew the answer thirty seconds earlier without saying it.
 */
export function signInFailureReason(): string | null {
  return state.signInFailure;
}

/**
 * Navigate-and-wait until the URL stops moving, then report where we landed.
 *
 * Replaces a flat `waitForTimeout(2_000)`. Two seconds was a guess about how long
 * Google's redirect chain takes, and a chain slower than that read as "signed out" on
 * a profile that was signed in — which then ran a full interactive login against an
 * already-authenticated account, burned 20-45 s finding no login form, and could leave
 * the session mid-rotation. That is the stale-profile hazard `isSignedIn` exists to
 * avoid, caused by the check meant to detect it.
 *
 * Polling for stability is also *cheaper* than the old sleep in the common case: a
 * chain that settles immediately costs about `SESSION_STABLE_MS`.
 */
export async function settledUrl(
  page: Pick<Page, 'url' | 'waitForTimeout'>,
  timeoutMs = SESSION_SETTLE_TIMEOUT_MS,
  stableMs = SESSION_STABLE_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = page.url();
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const current = page.url();
    if (current !== last) {
      last = current;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= stableMs) break;
  }
  return page.url();
}

/** Wait for a locator to become visible, answering false instead of throwing. */
async function appearsVisible(locator: Locator, timeoutMs: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sign the browser into Google, if an account is configured and the profile isn't
 * signed in already.
 *
 * `force` skips the "am I already signed in?" probe. The caller passes it after the
 * platform has told us the session is stale, which is exactly the case that probe
 * gets wrong: it navigates to the account page and believes what it sees, while Meet
 * hands the same profile a guest name field.
 */
export async function signInToGoogle(page: Page, options?: { force?: boolean }): Promise<void> {
  // Reset first: this module outlives a single meeting, and stale auth state is
  // worse than none — see `state` above.
  state.authenticated = false;
  state.signInFailure = null;

  const email = config.googleBotEmail;
  const password = config.googleBotPassword;
  if (!email || !password) {
    logger.info('[Meeting] No Google account configured — joining as an anonymous guest');
    return;
  }
  if (!options?.force && (await isSignedIn(page))) {
    state.authenticated = true;
    logger.info('[Meeting] Reusing the signed-in session from the persisted profile');
    return;
  }

  logger.info(`[Meeting] Signing in as ${email.replace(/^[^@]+/, '***')}`);
  try {
    // `hl=en` pins the interface language. Without it Google localizes from the
    // egress IP — a German page rendered here once — and every selector below is
    // written in English. `ServiceLogin` (rather than the bare origin) asks for
    // the identifier form instead of whatever Google decides to show.
    await page.goto(
      'https://accounts.google.com/ServiceLogin?hl=en&continue=https%3A%2F%2Fmyaccount.google.com%2F',
      { waitUntil: 'domcontentloaded', timeout: 45_000 },
    );

    // The identifier field is `type="text"`, not `type="email"` — matching on
    // type finds nothing and times out.
    const identifier = page.locator('#identifierId');
    if (!(await appearsVisible(identifier, 8_000))) {
      // A leftover session shows an account chooser rather than the email form.
      // "Use another account" is the way back to it.
      const another = page
        .getByRole('link', { name: /use another account/i })
        .or(page.getByRole('button', { name: /use another account/i }))
        .first();
      if (await appearsVisible(another, 5_000)) {
        logger.info('[Meeting] Account chooser shown; asking for the sign-in form');
        await another.click({ timeout: 5_000 });
      }
    }
    if (!(await appearsVisible(identifier, 20_000))) {
      // No identifier form and no account chooser normally means Google decided we
      // were already authenticated and sent us straight through. Re-ask instead of
      // reporting a failure — the old bare `waitFor` threw here, which is how a
      // good profile ended up flagged as a failed sign-in.
      if (await isSignedIn(page)) {
        state.authenticated = true;
        logger.info('[Meeting] Already signed in — Google skipped the login form');
        return;
      }
      throw new Error('the Google sign-in form never appeared');
    }
    await identifier.click();
    await identifier.type(email, { delay: 60 });
    await page.getByRole('button', { name: /^next$/i }).first().click({ timeout: 10_000 });

    const pw = page.locator('input[type="password"]:visible, input[name="Passwd"]').first();
    await pw.waitFor({ state: 'visible', timeout: 25_000 });
    await pw.click();
    await pw.type(password, { delay: 60 });
    await page.getByRole('button', { name: /^next$/i }).first().click({ timeout: 10_000 });

    // Wait for the post-password redirect chain to stop moving rather than sleeping
    // a flat 8 s: a slow interstitial used to make the check below run early and
    // report failure for a login that was about to succeed.
    await settledUrl(page, 45_000);

    if (await isSignedIn(page)) {
      state.authenticated = true;
      logger.info('[Meeting] Signed in; the profile will be reused on later calls');
      return;
    }
    // Most often a "verify it's you" challenge, which needs a code only a human
    // has. Say so plainly instead of leaving a silent guest join to fail later.
    const visible = await page
      .locator('body')
      .innerText({ timeout: 3_000 })
      .catch(() => '');
    state.signInFailure = 'Google is likely challenging this account';
    logger.warn(
      `[Meeting] Sign-in did not complete — Google is likely challenging this account. ` +
        `Page said: ${visible.replace(/\s+/g, ' ').slice(0, 200)}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.signInFailure = message;
    logger.warn(`[Meeting] Sign-in failed: ${message}`);
  }
}

/**
 * Whether Google still accepts this profile's session — asked by navigating, not
 * by looking for a cookie.
 *
 * A cookie check was the obvious implementation and it was wrong in the way that
 * mattered: Google's auth cookies rotate, and a profile whose browser was killed
 * mid-rotation keeps a `__Secure-1PSID` that Google no longer honours. We reported
 * "signed in", Meet disagreed, offered a guest name field, and the join was
 * auto-denied — with nothing in the logs pointing at the session.
 *
 * `myaccount.google.com` is the test because it only stays on that origin for a
 * live session; without one it bounces to `accounts.google.com` or to the
 * `www.google.com/account/about` marketing page. Returning false is what triggers
 * a fresh login, so a stale profile heals itself.
 */
async function isSignedIn(page: Page): Promise<boolean> {
  try {
    await page.goto('https://myaccount.google.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    // Judged only once the redirect chain has stopped moving — see `settledUrl`.
    const url = await settledUrl(page);
    if (url.startsWith('https://myaccount.google.com/')) return true;
    logger.info(`[Meeting] Profile is not signed in (settled on ${new URL(url).origin})`);
    return false;
  } catch (err) {
    logger.debug(`[Meeting] Sign-in check failed: ${String(err)}`);
    return false;
  }
}

