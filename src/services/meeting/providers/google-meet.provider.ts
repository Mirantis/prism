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
import { logger } from '../../../logger';
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

/**
 * Wait for a locator to be visible *and* enabled.
 *
 * Visibility alone is not enough for a button whose disabled state is the whole
 * signal — see the join-button race in `enterDisplayName`.
 */
async function appearsEnabled(locator: Locator, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await appears(locator, Math.min(1_000, Math.max(100, deadline - Date.now())))) {
      try {
        if (await locator.isEnabled()) return true;
      } catch {
        // Went stale between checks; try again.
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** How long to wait for the initial page furniture before deciding it's broken. */
const PAGE_READY_TIMEOUT_MS = 45_000;

/** Gap between attempts to find the join button (the UI settles in stages). */
const JOIN_RETRY_INTERVAL_MS = 2_000;

/** How long to keep looking for a join button before giving up. */
const JOIN_BUTTON_TIMEOUT_MS = 60_000;

/** How long to wait for the guest name field to render. */
const NAME_FIELD_TIMEOUT_MS = 20_000;

/**
 * Accessible-name patterns for the button that submits a join request.
 *
 * Matched as substrings, not exact strings: Meet appends device state to the
 * accessible name, so the guest button is really "Ask to join without camera".
 * An anchored match silently finds nothing.
 */
const JOIN_BUTTON_PATTERNS = [/ask to join/i, /join now/i, /join anyway/i, /switch here/i];

/** Signs the meeting rejected us outright, mapped to what to tell the user. */
const REJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Meet's catch-all wall. It covers an ended meeting, a link that was never
  // valid, and a tenant that blocks anonymous guests — and the page says the same
  // thing for all three, so the message lists them instead of asserting one.
  { pattern: /you can'?t join this (video call|meeting)/i, reason: "Google Meet wouldn't let me in. Either the meeting has ended, the link is no longer valid, or this meeting only admits signed-in members of its organization." },
  { pattern: /no one responded to your request/i, reason: 'Nobody admitted the request to join.' },
  { pattern: /your request to join was denied/i, reason: 'A host denied the request to join.' },
  { pattern: /this meeting hasn'?t started/i, reason: "The meeting hasn't started yet." },
  { pattern: /(the )?meeting (has )?ended/i, reason: 'The meeting has already ended.' },
  { pattern: /check your meeting code/i, reason: 'Google Meet did not recognize that meeting link.' },
  { pattern: /invalid video call name/i, reason: 'Google Meet did not recognize that meeting link.' },
];

export class GoogleMeetProvider implements MeetingProvider {
  readonly name = 'google-meet';
  readonly displayName = 'Google Meet';

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
    const deadline = Date.now() + options.admissionTimeoutMs;

    try {
      await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: PAGE_READY_TIMEOUT_MS });
    } catch (err) {
      return { status: 'failed', reason: `Could not load the meeting page: ${err instanceof Error ? err.message : String(err)}` };
    }

    // A rejection can be on screen before we ever reach the name field.
    const earlyRejection = await this.findRejection(page);
    if (earlyRejection) return { status: 'denied', reason: earlyRejection };

    await this.dismissDeviceDialogs(page);
    // Before the camera toggle and the join click: Meet keeps the join button
    // disabled until the guest name has a value.
    const nameEntered = await this.enterDisplayName(page, options.displayName, options.signedIn === true);
    await this.turnOffCamera(page);

    const clicked = await this.clickJoinButton(page, deadline);
    if (!clicked) {
      const rejection = await this.findRejection(page);
      if (rejection) return { status: 'denied', reason: rejection };
      return {
        status: 'failed',
        reason: nameEntered
          ? 'The join button never became available — the Meet page may have changed.'
          : 'Could not enter a name, so the join button stayed disabled — the Meet page may have changed.',
      };
    }

    return this.waitForAdmission(page, deadline);
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
   * Enter the guest name.
   *
   * Not optional in practice: the join button is disabled until this field has a
   * value, so failing here means the flow can never proceed. Given a generous
   * wait because the field is rendered a moment after the page's first paint.
   */
  private async enterDisplayName(
    page: Page,
    displayName: string,
    signedIn: boolean,
  ): Promise<boolean> {
    // Raced against the join button rather than waited for outright. A signed-in
    // account never gets a name field, so waiting the full timeout on each selector
    // in turn added a silent minute to every signed-in join — the browser sitting on
    // a ready page, looking for something that will never appear.
    const nameField = page
      .locator('input[aria-label="Your name"]')
      .or(page.locator('input[placeholder="Your name"]'))
      .or(page.locator('input[type="text"][aria-label*="name" i]'))
      .first();
    const joinButton = page.getByRole('button', { name: /ask to join|join now/i }).first();

    const found = await Promise.race([
      appears(nameField, NAME_FIELD_TIMEOUT_MS).then((ok) => (ok ? 'name' : 'neither')),
      // Deliberately waits for *enabled*, not merely visible. On the guest lobby Meet
      // paints the name field and a disabled "Ask to join" in the same frame, so a
      // visibility race could declare "no name needed", never fill the field, and
      // then spend 60s watching a button that stays disabled forever.
      appearsEnabled(joinButton, NAME_FIELD_TIMEOUT_MS).then((ok) => (ok ? 'join' : 'neither')),
    ]);

    if (found === 'join') {
      // Signed in: Meet already knows who we are.
      logger.info('[Meeting] Recognized as a signed-in participant — no name needed');
      return false;
    }
    if (found === 'name') {
      if (signedIn) {
        // Meet shows a guest name field to a signed-in visitor whose meeting has
        // ended, so this is the clearest early warning that the link is dead — and
        // it previously looked identical to "sign-in didn't work".
        logger.warn(
          '[Meeting] A guest name field appeared even though the browser is signed in — ' +
            'the meeting has most likely ended or the link is no longer valid',
        );
      }
      try {
        await nameField.fill(displayName, { timeout: 5_000 });
        logger.info(`[Meeting] Entered display name "${displayName}"`);
        return true;
      } catch (err) {
        logger.warn(`[Meeting] Could not fill the name field: ${String(err)}`);
      }
    }
    // Neither appeared: report it and let the join attempt produce the real error.
    logger.info('[Meeting] Neither a name field nor a join button appeared yet');
    return false;
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
   */
  private async clickJoinButton(page: Page, deadline: number): Promise<boolean> {
    const buttonDeadline = Math.min(deadline, Date.now() + JOIN_BUTTON_TIMEOUT_MS);

    while (Date.now() < buttonDeadline) {
      for (const pattern of JOIN_BUTTON_PATTERNS) {
        try {
          const button = page.getByRole('button', { name: pattern }).first();
          if (!(await appears(button, 1_000))) continue;
          // Present but disabled is the normal state until the name field has a
          // value and Meet has finished probing devices, so this is a retry
          // condition rather than a failure.
          if (!(await button.isEnabled())) {
            logger.debug(`[Meeting] Join button matching ${pattern} is not enabled yet`);
            continue;
          }
          await button.click({ timeout: 5_000 });
          logger.info(`[Meeting] Clicked the join button (matched ${pattern})`);
          return true;
        } catch {
          // Not this pattern, or it went stale mid-check — keep looking.
        }
      }

      if (await this.findRejection(page)) return false;
      await page.waitForTimeout(JOIN_RETRY_INTERVAL_MS);
    }

    return false;
  }

  /**
   * Wait out the waiting room.
   *
   * Admission is inferred from in-call furniture appearing (the leave button, the
   * participants panel) because Meet exposes no explicit "you are in" signal.
   */
  private async waitForAdmission(page: Page, deadline: number): Promise<JoinOutcome> {
    logger.info('[Meeting] Waiting to be admitted');

    while (Date.now() < deadline) {
      if (await this.isInCall(page)) {
        logger.info('[Meeting] Admitted to the call');
        return { status: 'admitted' };
      }

      const rejection = await this.findRejection(page);
      if (rejection) return { status: 'denied', reason: rejection };

      await page.waitForTimeout(1_500);
    }

    return {
      status: 'denied',
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

  /** Scan the visible text for a known rejection, returning what to tell the user. */
  private async findRejection(page: Page): Promise<string | null> {
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
   * Read the participant count from the UI.
   *
   * Returns null rather than guessing when the count can't be read: the caller
   * uses this to auto-leave an empty meeting, and a selector change must not
   * eject the bot from a call that is still going.
   */
  async participantCount(page: Page): Promise<number | null> {
    try {
      const attr = await page
        .locator('[data-participant-count]')
        .first()
        .getAttribute('data-participant-count', { timeout: 1_000 });
      if (attr) {
        const parsed = parseInt(attr, 10);
        if (Number.isFinite(parsed)) return parsed;
      }
    } catch {
      // Fall through to the label-based reading.
    }

    try {
      // The People button's accessible name carries the count, e.g. "People (3)".
      const label = await page
        .locator('button[aria-label*="People" i]')
        .first()
        .getAttribute('aria-label', { timeout: 1_000 });
      const match = label?.match(/(\d+)/);
      if (match) return parseInt(match[1], 10);
    } catch {
      // Unknown.
    }

    return null;
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
