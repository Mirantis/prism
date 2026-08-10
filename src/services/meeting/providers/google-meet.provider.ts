/**
 * Google Meet, joined as an anonymous guest.
 *
 * Guest rather than signed-in, deliberately. Automated Chrome hitting Google's
 * login is met with "this browser or app may not be secure", and the stealth
 * plugins that work elsewhere are well documented not to work on that flow. The
 * guest path avoids the login surface entirely; the cost is that a host has to
 * click "Admit", and that some Workspace tenants disallow anonymous joins at all.
 * Both are reported back as outcomes rather than treated as failures.
 *
 * Everything here is selector-matching against a UI Google reshapes regularly, so
 * each step accepts several phrasings and the whole flow degrades to a clear
 * message instead of a stack trace. Expect to revisit the selectors; that is the
 * standing maintenance cost of every browser-automation meeting bot.
 */

import type { Page } from 'playwright-core';
import { logger } from '../../../logger';
import type { JoinOptions, JoinOutcome, MeetingProvider } from '../meeting-provider.interface';

/** How long to wait for the initial page furniture before deciding it's broken. */
const PAGE_READY_TIMEOUT_MS = 45_000;

/** Gap between attempts to find the join button (the UI settles in stages). */
const JOIN_RETRY_INTERVAL_MS = 2_000;

/** How long to keep looking for a join button before giving up. */
const JOIN_BUTTON_TIMEOUT_MS = 60_000;

/** Text on the button that submits a join request, in rough priority order. */
const JOIN_BUTTON_LABELS = ['Ask to join', 'Join now', 'Join anyway', 'Switch here'];

/** Signs the meeting rejected us outright, mapped to what to tell the user. */
const REJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /you can'?t join this (video call|meeting)/i, reason: 'Google Meet refused the join — the meeting may be restricted to signed-in members of its organization.' },
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
    await this.enterDisplayName(page, options.displayName);
    await this.turnOffCamera(page);

    const clicked = await this.clickJoinButton(page, deadline);
    if (!clicked) {
      const rejection = await this.findRejection(page);
      return rejection
        ? { status: 'denied', reason: rejection }
        : { status: 'failed', reason: 'Could not find a way to join — the Meet page may have changed.' };
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
    const labels = ['Continue without microphone and camera', 'Continue without microphone', 'Dismiss', 'Got it'];
    for (const label of labels) {
      try {
        const button = page.getByRole('button', { name: new RegExp(label, 'i') });
        if (await button.first().isVisible({ timeout: 1_000 })) {
          await button.first().click({ timeout: 2_000 });
          logger.info(`[Meeting] Dismissed Meet dialog: ${label}`);
        }
      } catch {
        // None of these are required — absence is the normal case.
      }
    }
  }

  /** Guests must supply a name; without it the join button stays disabled. */
  private async enterDisplayName(page: Page, displayName: string): Promise<void> {
    const selectors = [
      'input[aria-label="Your name"]',
      'input[placeholder="Your name"]',
      'input[type="text"][aria-label*="name" i]',
    ];
    for (const selector of selectors) {
      try {
        const input = page.locator(selector).first();
        if (await input.isVisible({ timeout: 3_000 })) {
          await input.fill(displayName, { timeout: 3_000 });
          logger.info(`[Meeting] Entered display name "${displayName}"`);
          return;
        }
      } catch {
        // Try the next phrasing.
      }
    }
    // Not fatal: a meeting that allows unnamed guests, or a signed-in profile,
    // has no name field at all.
    logger.info('[Meeting] No name field present — continuing');
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
      if (await camera.isVisible({ timeout: 2_000 })) {
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
      for (const label of JOIN_BUTTON_LABELS) {
        try {
          const button = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
          if (await button.isVisible({ timeout: 500 })) {
            if (await button.isEnabled({ timeout: 500 })) {
              await button.click({ timeout: 5_000 });
              logger.info(`[Meeting] Clicked "${label}"`);
              return true;
            }
          }
        } catch {
          // Not this label, or it went stale mid-check — keep looking.
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
      try {
        if (await page.locator(selector).first().isVisible({ timeout: 400 })) return true;
      } catch {
        // Keep checking the others.
      }
    }
    return false;
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
        if (await button.isVisible({ timeout: 2_000 })) {
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
