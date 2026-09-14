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
import type { Frame, Locator, Page } from 'playwright-core';
import { config } from '../../../../config';
import { logger } from '../../../../logger';

/**
 * How long to let Google's redirect chain settle before judging the session, and how
 * long the URL must hold still to count as settled.
 */
const SESSION_SETTLE_TIMEOUT_MS = 15_000;
const SESSION_STABLE_MS = 1_000;

/**
 * How long one parking attempt gets, and how long the main frame must record no
 * navigation to count as still. The quiet window must be the shorter of the two.
 *
 * 500 ms is a judgement, not a measurement: the commit that produced this defect
 * landed about 200 ms after its own navigation resolved, and this leaves margin
 * without adding a second to every failed sign-in.
 */
const QUIESCE_SETTLE_TIMEOUT_MS = 3_000;
const QUIESCE_QUIET_MS = 500;

/** What Google answered about a profile's session, and the reading it rests on. */
export type SessionEvidence = { live: boolean; signal: string };

/**
 * What the last sign-in attempt read: why it failed, when one did, and what Google
 * answered about the profile's session.
 *
 * Module-level because the provider it serves is a module singleton, and both fields
 * are reset on every `signInToGoogle` call: the alternative is one meeting's reading
 * deciding the next meeting's join. One call at a time is what makes that reset
 * enough, and the voice lock holds it — a meeting owns it from its startup to its
 * teardown, so two sign-ins cannot interleave here.
 */
const state: {
  signInFailure: string | null;
  session: SessionEvidence | null;
} = { signInFailure: null, session: null };

/**
 * Whether this browser is *meant* to be signed into a Google account.
 *
 * Deliberately "meant to be" rather than "was confirmed to be". It answers one
 * question — should Meet offering a guest name field be read as a stale session? —
 * and for that, intent is the right test and confirmation is the wrong one.
 *
 * Confirmation belongs in the other half of that decision, and it is
 * `sessionEvidence()`: whether Meet's guest field means a stale session depends on
 * both readings, and this one says only that a session is meant to exist.
 */
export function isAuthenticated(): boolean {
  return Boolean(config.googleBotEmail && config.googleBotPassword);
}

/**
 * What Google answered about this profile's session on the last sign-in call, and the
 * reading the answer rests on.
 *
 * Null when no call has run for this browser, which the caller reads as "not
 * confirmed" — the safe direction, since a session nobody has checked may well be
 * refused.
 */
export function sessionEvidence(): SessionEvidence | null {
  return state.session;
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
 * `force` skips the "am I already signed in?" probe. The caller passes it once the
 * probe has already answered that the session is not live and Meet agrees, so asking
 * again spends the settle budget for an answer we hold.
 */
export async function signInToGoogle(page: Page, options?: { force?: boolean }): Promise<void> {
  // Reset first: this module outlives a single meeting, and stale auth state is
  // worse than none — see `state` above.
  state.signInFailure = null;
  state.session = null;

  const email = config.googleBotEmail;
  const password = config.googleBotPassword;
  if (!email || !password) {
    logger.info('[Meeting] No Google account configured — joining as an anonymous guest');
    return;
  }
  if (!options?.force) {
    const session = await readSession(page);
    if (session.live) {
      logger.info('[Meeting] Reusing the signed-in session from the persisted profile');
      return;
    }
    // Name what refused the session, at the moment the password is about to be typed.
    // A login this account did not need is what earns it a Google challenge, so the log
    // has to say which reading asked for this one.
    logger.info(`[Meeting] Signing in: ${session.signal}`);
  }

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
        await another.click({ timeout: 5_000 });
      }
    }
    if (!(await appearsVisible(identifier, 20_000))) {
      // No identifier form and no account chooser normally means Google decided we
      // were already authenticated and sent us straight through. Re-ask instead of
      // reporting a failure — the old bare `waitFor` threw here, which is how a
      // good profile ended up flagged as a failed sign-in.
      if ((await readSession(page)).live) {
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

    if ((await readSession(page)).live) {
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

  // Whatever happened above, leave the page still. A sign-in that failed is the one
  // most likely to be mid-redirect, and the very next thing this browser does is
  // load the meeting — which is how a sign-in problem came to be reported to users
  // as a broken meeting link.
  await quiesce(page);
}

/**
 * What `quiesce` uses a page for, narrowed the way `settledUrl` is: a test drives it
 * with a stub rather than a browser.
 */
export type QuiescePage = Pick<Page, 'url' | 'goto' | 'waitForTimeout' | 'on' | 'off' | 'mainFrame'>;

/**
 * Park the page on a blank document, and hand it back only once nothing is navigating.
 *
 * A failed sign-in does not leave a still page. Google's redirect chains outlive the
 * navigation that started them — an error page about to commit, a `ServiceLogin`
 * bounce still resolving — and whatever navigates next inherits them. The shape this
 * takes in production is a join reporting
 *
 *     Could not load the meeting page: Navigation to "https://meet.google.com/abc"
 *     is interrupted by another navigation to "about:blank"
 *
 * which reads as a broken meeting link and is nothing of the sort. The sign-in
 * failure is the real story and it was two steps upstream.
 *
 * Stillness is measured from the main frame's navigation commits, the event Playwright
 * raises "interrupted by another navigation" from. The parking `goto` resolves with a
 * commit still to come, and `page.url()` reads `about:blank` either side of that
 * commit, so the page counts as still only once `quietMs` passes with no commit and it
 * reads the blank document.
 *
 * A quiet page reading anything else means the late commit was somebody else's, so the
 * parking is done again. Best effort, in two attempts: if even `about:blank` will not
 * settle, the caller has worse problems than a page that is still moving.
 */
export async function quiesce(
  page: QuiescePage,
  timeoutMs = QUIESCE_SETTLE_TIMEOUT_MS,
  quietMs = QUIESCE_QUIET_MS,
): Promise<void> {
  let lastCommit = Date.now();
  const onNavigated = (frame: Frame): void => {
    if (frame === page.mainFrame()) lastCommit = Date.now();
  };

  page.on('framenavigated', onNavigated);
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // One budget for the whole attempt, the navigation included: the caller of a
      // failed sign-in is waiting on this, and a `goto` with a cap of its own would
      // spend that cap on top of the wait below.
      const deadline = Date.now() + timeoutMs;
      await page
        .goto('about:blank', { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        .catch(() => undefined);

      while (Date.now() < deadline) {
        // `waitForTimeout` rejects once the page is closed, and nothing in this file
        // throws — see the header. A closed page is also still enough for the caller.
        const polled = await page.waitForTimeout(100).then(
          () => true,
          () => false,
        );
        if (!polled) return;
        if (Date.now() - lastCommit < quietMs) continue;
        if (page.url() === 'about:blank') return;
        break;
      }
    }
  } finally {
    page.off('framenavigated', onNavigated);
  }
}

/**
 * What Google says about this profile's session — asked by navigating, not by looking
 * for a cookie.
 *
 * A cookie check was the obvious implementation and it was wrong in the way that
 * mattered: Google's auth cookies rotate, and a profile whose browser was killed
 * mid-rotation keeps a `__Secure-1PSID` that Google no longer honours. We reported
 * "signed in", Meet disagreed, offered a guest name field, and the join was
 * auto-denied — with nothing in the logs pointing at the session.
 *
 * `myaccount.google.com` is the test because it only stays on that origin for a
 * live session; without one it bounces to `accounts.google.com` or to the
 * `www.google.com/account/about` marketing page. A reading that is not live is what
 * triggers a fresh login, so a stale profile heals itself.
 *
 * Every exit records its reading as well as returning it. This is the one place that
 * sees the settled URL, and the provider asks for the reading later, once the join
 * reaches Meet's lobby.
 */
async function readSession(page: Page): Promise<SessionEvidence> {
  // Twice, because the first navigation can be interrupted by a redirect chain that
  // is still running — Google's own — and reject for a session that is perfectly
  // alive. Watched live: a profile whose account page was rendering ("Skip to main
  // content Account") while this reported it signed out, because the rejection was
  // swallowed at debug level and read as a negative rather than as no answer at all.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto('https://myaccount.google.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      // Judged only once the redirect chain has stopped moving — see `settledUrl`.
      const url = await settledUrl(page);
      if (url.startsWith('https://myaccount.google.com/')) {
        return record({ live: true, signal: 'the account page stayed on myaccount.google.com' });
      }
      return record({ live: false, signal: `the account page settled on ${landingOf(url)}` });
    } catch (err) {
      // Loud, and never at debug: this used to be the quietest line in the file and
      // the one that most often decided a join.
      logger.info(`[Meeting] Sign-in check could not complete (attempt ${attempt}): ${String(err)}`);
      // Before the retry as well as before returning: the failed navigation is still
      // settling, and the next `goto` — here or in the sign-in that follows — is
      // otherwise interrupted by it.
      await quiesce(page);
    }
  }
  logger.warn('[Meeting] Could not establish whether the profile is signed in — assuming it is not');
  return record({ live: false, signal: 'the account session check could not complete' });
}

/** Keep the reading for the provider, and hand it back to the caller. */
function record(evidence: SessionEvidence): SessionEvidence {
  state.session = evidence;
  return evidence;
}

/**
 * Where a settled URL landed, without its query — a `continue=` value is Google's
 * business and not log material. The path stays: it is what tells the signed-out
 * `www.google.com/account/about` page from anything else on that host.
 */
function landingOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

