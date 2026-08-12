/**
 * Google Meet, joined as a signed-in participant.
 *
 * Signed in is not a preference, it is the only thing that works. Joining
 * anonymously was tried first and Google auto-denies it: the `CreateMeetingDevice`
 * RPC comes back 403 a second or two after clicking "Ask to join", and the host is
 * never even shown a request. That is policy, not fingerprinting — patched
 * automation (`patchright`), real Chrome, human-like pacing and honest user agents
 * all hit the same wall, while the same browser signed into an account walks in.
 * See `browser-stack.ts` for the sign-in itself.
 *
 * Guest support is still here because the anonymous flow is what a *host-less*
 * meeting shows: Meet offers a guest name field for a link whose meeting has ended,
 * even to a signed-in visitor, so the code has to handle it — and `signedIn` tells
 * the two apart in the logs, which is exactly the distinction that cost hours.
 *
 * Everything below is selector-matching against a UI Google reshapes regularly, so
 * each step accepts several phrasings and the whole flow degrades to a clear message
 * instead of a stack trace. Expect to revisit the selectors; that is the standing
 * maintenance cost of every browser-automation meeting bot.
 */

import type { Locator, Page } from 'playwright-core';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { isAuthenticated, signInFailureReason, signInToGoogle } from './google-meet/sign-in';
import type { JoinOptions, JoinOutcome, MeetingProvider } from '../meeting-provider.interface';

/**
 * Wait for a locator to actually be visible, returning false instead of throwing.
 *
 * `locator.isVisible()` is deliberately NOT used anywhere in this file: it answers
 * "is it visible right now" and returns immediately — its `timeout` option does not
 * make it wait. Meet renders its join UI in stages, so an immediate check runs
 * before the name field or the join button exist and reports them absent. That
 * mistake is invisible in the logs (the flow just says it found nothing), so the
 * waiting form is factored out here to keep it out of reach.
 */
async function appears(locator: Locator, timeoutMs: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** How long to wait for the initial page furniture before deciding it's broken. */
const PAGE_READY_TIMEOUT_MS = 45_000;

/** Gap between attempts to find the join button (the UI settles in stages). */
const JOIN_RETRY_INTERVAL_MS = 2_000;

/** How long to keep looking for a join button before giving up. */
const JOIN_BUTTON_TIMEOUT_MS = 60_000;

/**
 * Slack in the lobby budget beyond the button hunt itself.
 *
 * Was the guest name field's own timeout, back when the flow waited for one. The
 * field is gone with guest joining, but the allowance is not wasted: Meet paints the
 * lobby in stages and the button often appears well after first paint, so the hunt
 * wants headroom beyond its own patience.
 */
const LOBBY_SLACK_MS = 20_000;

/**
 * Budget for everything before the join request is in — the lobby and the button
 * hunt.
 *
 * Deliberately separate from the admission budget. Both used to come out of one
 * deadline computed before `page.goto`, so a slow page load (up to 45 s) plus a slow
 * button hunt (up to 60 s) silently spent the waiting-room budget, and in the tail
 * `waitForAdmission` was entered with its deadline already past — reporting "nobody
 * admitted the request" without having waited even once.
 *
 * The trade is a longer worst case: roughly 45 s page load + 80 s lobby + the full
 * admission budget, so about 7 minutes at the 300 s default, against about 6 before.
 * Nothing user-facing blocks on it — `runJoin` is fire-and-forget and
 * `MEETING_TIMEOUT_MINUTES` still caps the call — and the alternative is failing a
 * join that was going to succeed.
 */
const LOBBY_PHASE_TIMEOUT_MS = LOBBY_SLACK_MS + JOIN_BUTTON_TIMEOUT_MS;

/**
 * Reads that must agree before a rejection is believed, and the gap between them.
 *
 * One read is whatever Meet happened to have painted in that instant, and acting on
 * it is terminal — so a single match is a hypothesis, not an answer. Meet is an SPA
 * that renders interstitials on the way to the lobby, and a rejection caught
 * mid-render is exactly the intermittent "the meeting has ended" that a retry
 * against the same live link then walked straight past.
 */
const REJECTION_CONFIRM_READS = 3;
const REJECTION_CONFIRM_INTERVAL_MS = 1_200;

/**
 * How long to look for a guest name field before concluding a signed-in profile is
 * still signed in. Paid on every join by an authenticated bot, so it is short: the
 * member lobby shows a join button and never this field, and a miss only falls
 * through to the path that handled it before.
 */
const STALE_SESSION_PROBE_MS = 2_500;

/** Throttle for the "still waiting on the join button" progress line. */
const BUTTON_REPORT_INTERVAL_MS = 10_000;

/**
 * The slice of the DOM the participant-count probe touches.
 *
 * Structural rather than the real `Document`, because this runtime compiles
 * against Node's libs only: adding `dom` to get one type would put `document`,
 * `fetch`, `Response` and the rest of the browser surface in scope for every
 * server module, where they are a source of confusion rather than help.
 */
interface CountElement {
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
}

interface CountDocument {
  querySelector(selectors: string): CountElement | null;
  querySelectorAll(selectors: string): ArrayLike<CountElement>;
}

/**
 * Undo Meet's doubled tile text.
 *
 * A participant tile renders the name twice — once visibly, once for assistive
 * tech — so `textContent` reads "Mario SarcherMario Sarcher" with a control label
 * glued on the end. Read from the live DOM rather than assumed: the last set of
 * selectors written from first principles matched nothing Meet actually serves.
 */
export function unglueTileName(raw: string): string | null {
  const text = raw.trim();

  // Only the doubling is trusted. Stripping trailing lowercase runs as "control
  // labels" was tried first and ate real names — "Miska" became "M" — which would
  // have handed the transcriber a single letter to bias towards. A tile that isn't
  // doubled is left to the menu-label reading rather than guessed at.
  for (let half = Math.floor(text.length / 2); half >= 2; half--) {
    const candidate = text.slice(0, half);
    if (text.slice(half, half * 2) === candidate) return candidate.trim() || null;
  }
  return null;
}

/** Strip Meet's per-participant menu label down to the name it names. */
export function nameFromOptionsLabel(label: string): string | null {
  const match = label.match(/^more options for\s+(.+?)\s*$/i);
  return match ? match[1] : null;
}

/**
 * Names are handed to the transcriber as decoding hints, so an implausible one is
 * worse than a missing one: it biases the recognizer toward a word nobody says.
 */
function plausibleName(name: string): boolean {
  // Any script, not just Latin: the reason this reads names at all is that a live
  // call rendered a participant's name in Japanese characters, and rejecting those
  // would drop exactly the hint most needed. The letter test only excludes strings
  // that are punctuation or digits — a stray badge rather than a person.
  return name.length >= 2 && name.length <= 40 && /\p{L}/u.test(name);
}

/**
 * Cap on one participant-count read.
 *
 * `page.evaluate` has no timeout of its own, and this runs on a timer for the
 * whole call: a read that never settles would stall every later poll behind it,
 * freezing both the response mode and the empty-room check.
 */
const COUNT_READ_TIMEOUT_MS = 2_000;

/** Reject if `promise` hasn't settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The guest name field.
 *
 * Shared by the classification race and the fill so the two cannot disagree. The
 * third alternative is scoped to "your name" rather than any label merely
 * *containing* "name": the looser form matched unrelated text inputs on a signed-in
 * lobby, filled one, and then logged the "meeting has most likely ended" warning at
 * nobody.
 */
function nameFieldLocator(page: Page): Locator {
  return page
    .locator('input[aria-label="Your name"]')
    .or(page.locator('input[placeholder="Your name"]'))
    .or(page.locator('input[type="text"][aria-label*="your name" i]'))
    .first();
}

/**
 * Accessible-name patterns for the button that submits a join request.
 *
 * Matched as substrings, not exact strings: Meet appends device state to the
 * accessible name, so the guest button is really "Ask to join without camera".
 * An anchored match silently finds nothing.
 */
const JOIN_BUTTON_PATTERNS = [/ask to join/i, /join now/i, /join anyway/i, /switch here/i];

/**
 * Meet's catch-all wall, which covers several unrelated causes — including the one
 * the runtime can often explain itself. See `explainDenial`.
 */
const CATCH_ALL_REJECTION =
  "Google Meet wouldn't let me in. Either the meeting has ended, the link is no longer valid, or this meeting only admits signed-in members of its organization.";

/**
 * What the join-button hunt concluded.
 *
 * Carries the rejection rather than dropping it — see `clickJoinButton`.
 */
type ClickOutcome = { clicked: true } | { clicked: false; rejection: string | null };

/** Signs the meeting rejected us outright, mapped to what to tell the user. */
const REJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Meet's catch-all wall. It covers an ended meeting, a link that was never
  // valid, and a tenant that blocks anonymous guests — and the page says the same
  // thing for all three, so the message lists them instead of asserting one.
  { pattern: /you can'?t join this (video call|meeting)/i, reason: CATCH_ALL_REJECTION },
  { pattern: /no one responded to your request/i, reason: 'Nobody admitted the request to join.' },
  { pattern: /your request to join was denied/i, reason: 'A host denied the request to join.' },
  { pattern: /this meeting hasn'?t started/i, reason: "The meeting hasn't started yet." },
  // Anchored to Meet's real copy. The old form made `has` optional, so the bare
  // substring "meeting ended" matched — and this text is scanned against the whole
  // visible page, including chat and captions once the bot is in the room.
  { pattern: /(this|the) (video call|meeting) has ended/i, reason: 'The meeting has already ended.' },
  { pattern: /check your meeting code/i, reason: 'Google Meet did not recognize that meeting link.' },
  { pattern: /invalid video call name/i, reason: 'Google Meet did not recognize that meeting link.' },
];

export class GoogleMeetProvider implements MeetingProvider {
  readonly name = 'google-meet';
  readonly displayName = 'Google Meet';
  /**
   * Meet denies an automated anonymous guest before a host is ever prompted — the
   * `CreateMeetingDevice` RPC answers 403 a second after "Ask to join". Real Chrome,
   * patched automation, human-like pacing and honest user agents all hit the same
   * wall; a signed-in account walks in. So an account is not a preference, and a
   * runtime without one cannot join at all.
   */
  configurationError(): string | null {
    if (config.googleBotEmail && config.googleBotPassword) return null;
    return (
      `I can't join ${this.displayName} without a Google account: it refuses ` +
      `automated guests before a host is ever asked. Set GOOGLE_BOT_EMAIL and ` +
      `GOOGLE_BOT_PASSWORD and I'll be able to join.`
    );
  }

  /**
   * Never rejects — see `sign-in.ts`. A failed login is not a reason to refuse a
   * join, because the profile's cookies decide whether the browser is signed in,
   * not this call's opinion of them.
   */
  async signIn(page: Page, options?: { force?: boolean }): Promise<void> {
    await signInToGoogle(page, options);
  }

  matchesUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname === 'meet.google.com';
    } catch {
      return false;
    }
  }

  async join(page: Page, options: JoinOptions): Promise<JoinOutcome> {
    const outcome = await this.attemptJoin(page, options);
    // Meet reshapes this UI regularly, and a failed join is otherwise only a line
    // of log text describing selectors that didn't match. A picture of what the
    // browser was actually looking at turns "the page may have changed" into
    // something diagnosable without reproducing the call.
    if (outcome.status !== 'admitted') await this.captureFailure(page);
    return outcome;
  }

  private async attemptJoin(page: Page, options: JoinOptions): Promise<JoinOutcome> {
    const startedAt = Date.now();

    try {
      await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: PAGE_READY_TIMEOUT_MS });
    } catch (err) {
      return { status: 'failed', step: 'page_load', reason: `Could not load the meeting page: ${err instanceof Error ? err.message : String(err)}` };
    }
    logger.info(`[Meeting] Meet page loaded in ${Date.now() - startedAt}ms`);

    // Everything up to the click shares this; the waiting room gets its own budget
    // below. Capped by the admission timeout as well so a caller asking for a short
    // join gets a short one.
    const lobbyDeadline = Date.now() + Math.min(options.admissionTimeoutMs, LOBBY_PHASE_TIMEOUT_MS);

    // A rejection can be on screen before we ever reach the name field — but at
    // `domcontentloaded` it can equally be a frame the SPA is about to replace, so
    // this has to be the confirmed reading rather than a single glance.
    const earlyRejection = await this.confirmedRejection(page);
    if (earlyRejection) return { status: 'denied', step: 'lobby', reason: this.explainDenial(earlyRejection) };

    await this.dismissDeviceDialogs(page);
    // Before the camera toggle and the join click: Meet keeps the join button
    // disabled until the guest name has a value.
    // Meet offering a guest name field to a browser we believe is signed in means
    // the session is stale, and going on from here is a guaranteed refusal: Meet
    // auto-denies automated anonymous guests without ever prompting a host. Say so
    // and let the caller sign in again, rather than spending a lobby wait to be
    // told no. (An unauthenticated join is a different case — that name field is
    // the expected path, not a symptom.)
    if (isAuthenticated() && (await this.guestNameFieldPresent(page, lobbyDeadline))) {
      logger.warn(
        '[Meeting] Meet is treating this signed-in profile as a guest — ' +
          'the session is stale, so signing in again before trying the link',
      );
      return { status: 'reauth_required' };
    }

    await this.turnOffCamera(page);

    const attempt = await this.clickJoinButton(page, lobbyDeadline);
    if (!attempt.clicked) {
      // Already confirmed inside the loop — reported as-is rather than re-confirmed,
      // because the page may have moved on since.
      if (attempt.rejection) {
        return { status: 'denied', step: 'lobby', reason: this.explainDenial(attempt.rejection) };
      }
      // Deliberately not split further by "did we run out of time". The button hunt
      // always runs to the lobby deadline, so an elapsed-budget test is true on every
      // failure path and would make the selector-rot message below unreachable —
      // which is the distinction that actually gets acted on.
      return {
        status: 'failed',
        step: 'join_button',
        reason: 'The join button never became available — the Meet page may have changed.',
      };
    }

    // Measured from the moment the request actually went in, not from the top of the
    // function — see `LOBBY_PHASE_TIMEOUT_MS`.
    return this.waitForAdmission(page, Date.now() + options.admissionTimeoutMs, options);
  }

  /**
   * Add the real cause to Meet's catch-all wall when we already know it.
   *
   * Meet says the same thing for an ended meeting, a dead link and a tenant that
   * blocks guests — and says it *also* when it refused us for being an automated
   * anonymous guest. In that last case the runtime knows why (sign-in failed
   * moments earlier) and used to say nothing, so an expired bot password read to
   * the user as "the meeting has ended".
   */
  private explainDenial(reason: string): string {
    // Only the catch-all wall is ambiguous enough to be worth annotating; "a host
    // denied the request" is already unambiguous and needs no help.
    const failure = signInFailureReason();
    if (!failure || reason !== CATCH_ALL_REJECTION) return reason;
    return (
      `${reason} I also couldn't sign in to the Google account configured for me ` +
      `(${failure}), and Google refuses automated anonymous guests — ` +
      `that is the most likely cause.`
    );
  }

  /**
   * Grant/dismiss the permission and device-preview dialogs.
   *
   * `--use-fake-ui-for-media-stream` auto-grants the browser permission prompt,
   * but Meet has its own "allow microphone" and "continue without" panels that sit
   * on top of the join UI.
   */
  private async dismissDeviceDialogs(page: Page): Promise<void> {
    // "Got it" dismisses the sign-in tooltip, which floats over the join column
    // and can otherwise intercept a click meant for the controls beneath it.
    const labels = ['Got it', 'Continue without microphone and camera', 'Continue without microphone', 'Dismiss'];
    for (const label of labels) {
      try {
        const button = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
        if (await appears(button, 1_500)) {
          await button.click({ timeout: 2_000 });
          logger.info(`[Meeting] Dismissed Meet dialog: ${label}`);
        }
      } catch {
        // None of these are required — absence is the normal case.
      }
    }
  }

  /**
   * Is Meet asking for a guest name?
   *
   * Only asked of a browser we believe is signed in, where the answer means the
   * session is stale. Deliberately short-tempered about it: the member lobby paints
   * a join button and no name field, so waiting the full lobby budget here would
   * delay every healthy join to catch a broken one. A miss is not costly — the join
   * goes ahead and Meet refuses it, which is the outcome this only makes faster and
   * clearer.
   */
  private async guestNameFieldPresent(page: Page, lobbyDeadline: number): Promise<boolean> {
    const budget = Math.max(0, Math.min(STALE_SESSION_PROBE_MS, lobbyDeadline - Date.now()));
    if (budget === 0) return false;
    try {
      await nameFieldLocator(page).waitFor({ state: 'visible', timeout: budget });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Leave the camera off.
   *
   * There is no camera device in the container, so this is about how the bot
   * appears to the room (an avatar tile rather than a broken video tile) and about
   * not having Meet retry a device that will never work.
   */
  private async turnOffCamera(page: Page): Promise<void> {
    try {
      const camera = page.getByRole('button', { name: /turn off camera/i }).first();
      if (await appears(camera, 2_000)) {
        await camera.click({ timeout: 2_000 });
        logger.info('[Meeting] Camera turned off');
      }
    } catch {
      // Already off, or no camera control on this page.
    }
  }

  /**
   * Find and press the join button, retrying while the page settles.
   *
   * Retrying rather than waiting once: the button's label changes as Meet decides
   * whether we're a guest ("Ask to join") or a member ("Join now"), and it is
   * briefly present-but-disabled in between.
   *
   * Hands back the rejection it found rather than a bare false. Discarding it meant
   * the caller had to confirm all over again — several seconds later — and if the
   * wall text had repainted away by then, a genuine denial was reported as "the join
   * button never became available", blaming the Meet UI for a refusal we had already
   * read twice.
   */
  private async clickJoinButton(page: Page, deadline: number): Promise<ClickOutcome> {
    const startedAt = Date.now();
    // `deadline` already carries the lobby-phase cap, so there is nothing left to
    // min() against here.
    const buttonDeadline = deadline;
    let lastReport = 0;

    while (Date.now() < buttonDeadline) {
      for (const pattern of JOIN_BUTTON_PATTERNS) {
        try {
          const button = page.getByRole('button', { name: pattern }).first();
          if (!(await appears(button, 1_000))) continue;
          // Present but disabled is the normal state until the name field has a
          // value and Meet has finished probing devices, so this is a retry
          // condition rather than a failure.
          if (!(await button.isEnabled())) {
            // Reported at info, throttled: at debug a 60-second hunt left no trace at
            // all, so the only evidence was the terminal "may have changed" message.
            if (Date.now() - lastReport > BUTTON_REPORT_INTERVAL_MS) {
              lastReport = Date.now();
              logger.info(
                `[Meeting] Join button matching ${pattern} is not enabled yet ` +
                  `(${Date.now() - startedAt}ms so far)`,
              );
            }
            continue;
          }
          await button.click({ timeout: 5_000 });
          logger.info(`[Meeting] Clicked the join button (matched ${pattern}) after ${Date.now() - startedAt}ms`);
          return { clicked: true };
        } catch {
          // Not this pattern, or it went stale mid-check — keep looking.
        }
      }

      const rejection = await this.confirmedRejection(page);
      if (rejection) return { clicked: false, rejection };
      await page.waitForTimeout(JOIN_RETRY_INTERVAL_MS);
    }

    logger.info(`[Meeting] Gave up looking for a join button after ${Date.now() - startedAt}ms`);
    return { clicked: false, rejection: null };
  }

  /**
   * Wait out the waiting room.
   *
   * Admission is inferred from in-call furniture appearing (the leave button, the
   * participants panel) because Meet exposes no explicit "you are in" signal.
   */
  private async waitForAdmission(page: Page, deadline: number, options: JoinOptions): Promise<JoinOutcome> {
    logger.info('[Meeting] Waiting to be admitted');
    const startedAt = Date.now();

    while (Date.now() < deadline) {
      if (await this.isInCall(page)) {
        logger.info(`[Meeting] Admitted to the call after ${Date.now() - startedAt}ms`);
        return { status: 'admitted' };
      }

      const rejection = await this.confirmedRejection(page);
      if (rejection) {
        // Confirming takes a couple of seconds, and admission can land inside that
        // window. Being in the room outranks any text on it.
        if (await this.isInCall(page)) {
          logger.info('[Meeting] Admitted while a rejection message was being confirmed');
          return { status: 'admitted' };
        }
        return { status: 'denied', step: 'admission', reason: this.explainDenial(rejection) };
      }

      await page.waitForTimeout(1_500);
    }

    return {
      status: 'denied',
      step: 'admission',
      reason: 'Nobody admitted the request to join before the wait timed out.',
    };
  }

  /** In-call furniture — the closest thing Meet gives us to an "admitted" flag. */
  private async isInCall(page: Page): Promise<boolean> {
    const markers = [
      'button[aria-label*="Leave call" i]',
      'button[aria-label*="Leave meeting" i]',
      'button[aria-label*="People" i]',
      '[data-participant-count]',
    ];
    for (const selector of markers) {
      if (await appears(page.locator(selector).first(), 400)) return true;
    }
    return false;
  }

  /**
   * Save what the page looked like when a join failed, best effort.
   *
   * Written into the persistent data dir under a fixed name — one artifact from
   * the most recent failure, not a growing pile — and never allowed to affect the
   * outcome being reported.
   */
  private async captureFailure(page: Page): Promise<void> {
    try {
      const { resolveDataDir } = await import('../../../lib/data-dir');
      const path = `${resolveDataDir()}/meeting-join-failure.png`;
      await page.screenshot({ path, timeout: 5_000 });
      logger.info(`[Meeting] Saved a screenshot of the failed join to ${path}`);
    } catch (err) {
      logger.debug(`[Meeting] Could not capture the failure screenshot: ${String(err)}`);
    }
  }

  /**
   * A rejection that held still — the only kind worth acting on.
   *
   * Costs nothing in the common case: a page with no rejection text takes one read
   * and returns. Only once something matches do we pay for confirmation, and that is
   * exactly when it is worth paying, because the alternative is ending the join on a
   * frame Meet was about to replace.
   */
  private async confirmedRejection(page: Page): Promise<string | null> {
    const first = await this.readRejection(page);
    if (!first) return null;

    for (let i = 1; i < REJECTION_CONFIRM_READS; i += 1) {
      // If we are already in the room, whatever the page says is stale by
      // definition — chat and captions are part of the text being scanned.
      if (await this.isInCall(page)) {
        logger.info('[Meeting] Ignoring rejection text — already in the call');
        return null;
      }
      await page.waitForTimeout(REJECTION_CONFIRM_INTERVAL_MS);
      // Compared on the mapped reason, so a *different* rejection on a later read
      // also counts as a page that has not settled.
      if ((await this.readRejection(page)) !== first) {
        logger.info(`[Meeting] A rejection message did not persist — continuing (was: ${first.slice(0, 60)})`);
        return null;
      }
    }
    return first;
  }

  /** Scan the visible text for a known rejection, returning what to tell the user. */
  private async readRejection(page: Page): Promise<string | null> {
    let text: string;
    try {
      text = (await page.locator('body').innerText({ timeout: 2_000 })) ?? '';
    } catch {
      return null;
    }
    for (const { pattern, reason } of REJECTION_PATTERNS) {
      if (pattern.test(text)) return reason;
    }
    return null;
  }

  /**
   * Read the participant count from the UI, the agent included.
   *
   * Two things ride on this: leaving once the room has emptied, and deciding
   * whether the agent answers everything or waits to be addressed. It is
   * therefore read four ways and the **largest** reading wins, because the two
   * failure directions are not equally bad. Reading high costs one person having
   * to say the agent's name; reading low puts a silent agent back to answering
   * every sentence in a room full of people, which is the bug this exists to
   * prevent. Returns null only when nothing could be read at all — never a guess,
   * since the caller must not eject the agent from a call that is still going.
   *
   * Checked against a live call rather than the docs: Meet renders **neither**
   * `[data-participant-count]` nor a `button[aria-label*="People"]`, the two the
   * first version relied on. They are kept as the first attempts anyway — they
   * cost nothing in the same pass and other Meet surfaces may still carry them —
   * but the readings that actually work are the People control's count badge and
   * the participant ids on the tiles.
   */
  /**
   * Who is in the room, as far as the DOM will say.
   *
   * Fed to the transcriber as decoding hints. The problem it solves is observed, not
   * theoretical: one call rendered "Miska" as "Mees", "Max" as "Mark", and a third
   * participant's name in Japanese characters. Names are the words a meeting
   * transcript is worst at and the ones this feature most depends on — the gate's
   * clearest refusals are of the form "the speaker addresses Isaac", which only holds
   * when Isaac survives transcription.
   *
   * Two readings, because they fail differently. The per-participant menu label is
   * clean but English ("More options for Ada Lovelace"); tile text is
   * language-independent but arrives doubled and with control labels glued on. Empty
   * on any failure — a missing hint costs accuracy, and nothing else.
   */
  async participantNames(page: Page): Promise<string[]> {
    try {
      const raw = await withTimeout(
        page.evaluate(() => {
          const doc = (globalThis as unknown as { document: CountDocument }).document;
          const labels: string[] = [];
          const tiles: string[] = [];

          for (const el of Array.from(doc.querySelectorAll('[aria-label]'))) {
            const label = el.getAttribute('aria-label');
            if (label && /^more options for /i.test(label)) labels.push(label);
          }
          for (const el of Array.from(doc.querySelectorAll('[data-participant-id]'))) {
            const text = el.textContent?.trim();
            if (text) tiles.push(text.slice(0, 120));
          }
          return { labels, tiles };
        }),
        COUNT_READ_TIMEOUT_MS,
      );

      const names = [
        ...raw.labels.map(nameFromOptionsLabel),
        ...raw.tiles.map(unglueTileName),
      ].filter((n): n is string => n !== null && plausibleName(n));

      // Case-insensitively unique: the same person appears as a tile and as a menu
      // label, and the two spellings need not match in case.
      const seen = new Map<string, string>();
      for (const name of names) if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
      return [...seen.values()];
    } catch (err) {
      logger.debug(`[Meeting] Could not read participant names: ${String(err)}`);
      return [];
    }
  }

  async participantCount(page: Page): Promise<number | null> {
    let readings: number[];
    try {
      // One `evaluate` rather than a locator per strategy: this runs on a timer
      // for the whole call, and four locator round-trips each with their own
      // timeout is a lot of work to repeat every ten seconds.
      readings = await withTimeout(
        page.evaluate(() => {
          // This body runs in the page, not in Node. The runtime's `lib` is
          // deliberately Node-only — pulling in `dom` would put `document`,
          // `fetch` and friends in scope for every server module — so the handful
          // of DOM members used here are described structurally instead.
          const doc = (globalThis as unknown as { document: CountDocument }).document;

          const found: number[] = [];
          const add = (value: number) => {
            if (Number.isFinite(value) && value > 0) found.push(value);
          };

          const attr = doc
            .querySelector('[data-participant-count]')
            ?.getAttribute('data-participant-count');
          if (attr) add(parseInt(attr, 10));

          const label = doc
            .querySelector('button[aria-label*="People" i]')
            ?.getAttribute('aria-label');
          const labelled = label?.match(/(\d+)/);
          if (labelled) add(parseInt(labelled[1], 10));

          // The People control renders its label and a count badge as separate
          // nodes, so the control's combined text reads "People2". Matched on the
          // container's text rather than a class name, because every class on that
          // subtree is a generated hash that changes without notice.
          for (const el of Array.from(doc.querySelectorAll('div,span,button'))) {
            const text = el.textContent?.trim() ?? '';
            if (text.length > 24) continue;
            const badge = text.match(/^people\s*(\d{1,4})$/i);
            if (badge) add(parseInt(badge[1], 10));
          }

          // Language-independent, and the only reading that survives a relabelled
          // People control. Distinct ids because the same participant appears both
          // as a tile and as a row once the roster panel is open. It can *under*
          // report if Meet stops rendering off-screen tiles in a large call, which
          // is exactly why the largest reading wins below.
          const ids = new Set(
            Array.from(doc.querySelectorAll('[data-participant-id]')).map((el) =>
              el.getAttribute('data-participant-id'),
            ),
          );
          add(ids.size);

          return found;
        }),
        COUNT_READ_TIMEOUT_MS,
      );
    } catch {
      // A closed page, a navigation mid-read, or a page too busy to answer.
      return null;
    }

    return readings.length > 0 ? Math.max(...readings) : null;
  }

  async leave(page: Page): Promise<void> {
    for (const name of [/leave call/i, /leave meeting/i]) {
      try {
        const button = page.getByRole('button', { name }).first();
        if (await appears(button, 2_000)) {
          await button.click({ timeout: 3_000 });
          logger.info('[Meeting] Left the call');
          return;
        }
      } catch {
        // Try the other label.
      }
    }
    // Not a failure: the browser is closed immediately after, which drops the
    // WebRTC session and removes the bot from the room anyway.
    logger.info('[Meeting] No leave button found — closing the browser instead');
  }
}

export const googleMeetProvider = new GoogleMeetProvider();
