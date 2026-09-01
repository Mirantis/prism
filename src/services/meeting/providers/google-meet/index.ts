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
import { config } from '../../../../config';
import { logger } from '../../../../logger';
import { isAuthenticated, signInFailureReason, signInToGoogle } from './sign-in';
import { judgeSpeaker, namesFrom, openParticipants, readRoom } from './participants';
import { withTimeout } from '../../../../utils/with-timeout';
import type {
  ChatSendResult,
  JoinOptions,
  JoinOutcome,
  MeetingProvider,
  ScreenShareOutcome,
  SpeakerReading,
} from '../../meeting-provider.interface';

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
 * The microphone toggle, matched on the thing about it that doesn't move.
 *
 * Not the accessible name: it flips from "Turn on microphone" to "Turn off
 * microphone" the instant the button is pressed, so a locator built from the label
 * we clicked matches nothing when we read the result back — and "matches nothing"
 * is indistinguishable from "still muted".
 *
 * `data-is-muted` is both stable and the state itself, so the same locator finds the
 * button and answers the question. The label narrows it to the microphone because the
 * camera toggle carries that attribute too, and neither the tag nor the role is
 * pinned: Meet has rendered these controls as `button` and as `div[role=button]` at
 * different times, and this needs to survive that.
 *
 * Exported for the tests, which drive the stub through this exact string rather than
 * a copy of it — a copy would keep passing after production changed.
 */
export const MIC_TOGGLE_SELECTOR = '[data-is-muted][aria-label*="microphone" i]';

/**
 * Modals that render over the call controls.
 *
 * Meet drops one on a fresh joiner ("Others may see your video differently"), and its
 * scrim eats pointer events — a click aimed at the mic underneath fails with
 * Playwright's "subtree intercepts pointer events" and keeps failing until it times
 * out. So the mic is only reachable once this is gone.
 */
export const BLOCKING_DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';

/**
 * Buttons the dialog sweep is allowed to press — anchored, and never a fallback.
 *
 * The tempting shortcut is "press whatever button this dialog offers", and it is the
 * bug this whole change is about: one of the buttons Meet offers is "Continue without
 * microphone", which joins with no capture device at all and cannot be undone by
 * unmuting afterwards. So the sweep only presses things whose entire name is a
 * dismissal, and a dialog it doesn't recognise is left alone and logged. Substring
 * matching would defeat the point — "Continue without microphone" contains none of
 * these, but the next unrecognised affirmative might.
 */
const DIALOG_DISMISS_PATTERNS = [/^got it$/i, /^dismiss$/i, /^close$/i, /^ok$/i, /^no thanks$/i];

/** Dialogs can be stacked, and dismissing one can reveal the next. */
const DIALOG_SWEEP_PASSES = 2;

/**
 * How long to look for a dialog, or for a dismiss button inside one.
 *
 * Short because it is paid up to `DIALOG_SWEEP_PASSES` × the pattern list per unmute
 * attempt, and every one of those probes is looking for something that is usually not
 * there. A dialog that needs longer than this to paint has not finished covering the
 * button we are about to click either.
 */
const DIALOG_PROBE_MS = 500;

/**
 * How long to wait for the mic toggle to paint before calling it absent.
 *
 * Paid only once per join, right after admission, and the call UI is already up by
 * then — but Meet paints the control bar in stages and reading too early would report
 * a rotted selector on a perfectly good call.
 */
const MIC_TOGGLE_TIMEOUT_MS = 10_000;

/**
 * Patience for the reads *after* the toggle has already been found once.
 *
 * Short on purpose: the first read establishes the control exists, so spending the
 * full ten seconds on each confirmation only makes a failing unmute take a minute and
 * a half to say so — while the room watches a silent tile.
 */
const MIC_RECHECK_MS = 1_500;

/** Cap on one unmute click. */
const MIC_CLICK_TIMEOUT_MS = 3_000;

/**
 * Tries at unmuting, and how long to let the toggle settle before believing a read.
 *
 * Two, not more, and the reason is that this control is a *toggle*: every attempt is
 * another chance to switch off a microphone that had just come on. One click plus one
 * retry covers the failure actually seen in production — a dialog scrim swallowing the
 * first click — and past that, more attempts trade a known hazard for a shrinking
 * chance of success. A human clicks it once and looks.
 */
const MIC_UNMUTE_ATTEMPTS = 2;
const MIC_SETTLE_MS = 750;

/**
 * Wall-clock cap on the whole unmute phase, retries and dialog sweeps included.
 *
 * This runs *after* `waitForAdmission` returns, so `admissionTimeoutMs` no longer caps
 * anything and something has to. Modest, because failing to unmute no longer ends the
 * call — the agent joins, says it cannot be heard, and listens — so patience here buys
 * very little and is paid in front of a room watching a silent tile.
 *
 * Tested between attempts, not inside one, so the true ceiling is this plus a final
 * attempt (~20s worst case, nearly all of it probes timing out on things that are not
 * there).
 */
const MIC_PHASE_TIMEOUT_MS = 15_000;

/**
 * The chat panel's controls, in one place: the toggle, the composer, the send button.
 *
 * All three match what a live call showed once: the toggle is
 * `aria-label="Chat with everyone"` with `aria-expanded` as its only state, the composer
 * is a `textarea[aria-label="Send a message"]`, and the send button carries **the same
 * accessible name as the composer** — which is why this one pins the tag, since a bare
 * `[aria-label="Send a message"]` matches both nodes.
 *
 * One reading of one Meet build is not a guarantee, and the panel a non-host sees, or a
 * tenant with chat turned off, was never measured. That is why they are constants and
 * why `sendChatMessage` tries several phrasings per step: correcting a selector should
 * be one edit here, not a hunt through a method.
 *
 * The design answer to an unverified selector is not more selectors, it is which way a
 * miss falls: every read in `sendChatMessage` reports the step it stopped at, and none
 * of them can produce a success. See that method.
 *
 * Exported for the tests, which drive the stub through these exact strings.
 */
export const CHAT_TOGGLE_SELECTOR = 'button[aria-label*="chat" i]';
export const CHAT_COMPOSER_SELECTOR = 'textarea[aria-label*="Send a message" i]';
export const CHAT_SEND_SELECTOR = 'button[aria-label*="Send a message" i]';

/** How long to wait for the chat control, and then the composer, to paint. */
const CHAT_PANEL_TIMEOUT_MS = 5_000;

/**
 * How long each later phrasing gets, once the expected one has not appeared.
 *
 * Short, because a rotted first selector pays this per candidate, and by then the page has
 * already had the full budget above to paint. Long enough not to be an instant check on a
 * busy page.
 */
const CHAT_FALLBACK_PROBE_MS = 500;

/**
 * How long to look for a send button, after Enter did not send.
 *
 * Short: the panel is open and painted by this point, so a button that is not there now is
 * not about to appear, and the wait is silence in the room.
 */
const CHAT_SEND_PROBE_MS = 1_000;

/**
 * The chat controls, each as an ordered list of phrasings.
 *
 * Ordered, and probed one at a time by `firstThatAppears` — `Locator.or()` cannot express
 * this. An `or` chain matches the union and `.first()` takes the first match **in the
 * document**, so the order written means nothing: whichever candidate's element sits
 * earlier in the DOM wins. That is wrong twice here. The send button carries the same
 * accessible name as the composer, so a union of the two resolves to whichever Meet renders
 * first. And the toggle's broadest phrasing, `aria-label*="chat"`, is a substring match that
 * can pick up another control in the bar — it is last so that it is used last.
 */
function chatToggleCandidates(page: Page): Locator[] {
  return [
    page.getByRole('button', { name: /chat with everyone/i }).first(),
    page.getByRole('button', { name: /^chat$/i }).first(),
    page.locator(CHAT_TOGGLE_SELECTOR).first(),
  ];
}

/** The composer. The last phrasing covers a contenteditable rather than a textarea. */
function chatComposerCandidates(page: Page): Locator[] {
  return [
    page.locator(CHAT_COMPOSER_SELECTOR).first(),
    page.locator('textarea[placeholder*="Send a message" i]').first(),
    page.locator('[role="textbox"][aria-label*="message" i]').first(),
  ];
}

/** The send button, tag pinned first so it is not confused with the composer. */
function chatSendCandidates(page: Page): Locator[] {
  return [
    page.locator(CHAT_SEND_SELECTOR).first(),
    page.getByRole('button', { name: /^send/i }).first(),
  ];
}

/**
 * The first candidate to appear, probed in the order written.
 *
 * The first gets the full budget, since it is the one a live call measured; the rest get one
 * short probe each, so a rotted first selector costs the fallbacks rather than a multiple of
 * the whole timeout.
 */
async function firstThatAppears(candidates: Locator[], timeoutMs: number): Promise<Locator | null> {
  for (const [index, candidate] of candidates.entries()) {
    const budget = index === 0 ? timeoutMs : CHAT_FALLBACK_PROBE_MS;
    if (await appears(candidate, budget)) return candidate;
  }
  return null;
}

/**
 * How many times to look for the message on the page, and how long between looks.
 *
 * Counted rather than clocked, like `REJECTION_CONFIRM_READS`: a wall-clock deadline
 * around a loop this cheap spins thousands of times in a test and hundreds against a
 * busy page, all of them asking the same question. Eight reads is about two seconds of
 * patience on a page that answers, for something that either lands in one render or is not
 * going to. A page that does not answer makes each read wait out its own timeout instead,
 * which is why the whole send has a deadline over it in the service.
 */
const CHAT_CONFIRM_READS = 8;
const CHAT_CONFIRM_INTERVAL_MS = 250;

/**
 * How many reads may go into the baseline count, and how long between them.
 *
 * Two agreeing reads end it, so a still panel pays one extra read and a panel painting its
 * history waits it out. Bounded at three reads because the wait is in front of the typing,
 * and everything before the message goes out is silence in the room.
 */
const BASELINE_SETTLE_READS = 3;
const BASELINE_SETTLE_INTERVAL_MS = 200;

/**
 * How much of the message has to appear on the page for it to count as sent.
 *
 * A prefix rather than the whole string: Meet may wrap, collapse or decorate a long
 * message, and a containment test on all 500 characters would fail on a message that
 * did go through. Enough to be unmistakable, short enough to survive rendering.
 */
const CONFIRM_NEEDLE_CHARS = 60;

/** Cap on one click or one read inside the chat flow. */
const CHAT_CLICK_TIMEOUT_MS = 3_000;
const CHAT_READ_TIMEOUT_MS = 2_000;

/**
 * Labels Meet has given the control that starts a presentation, newest first.
 *
 * Anchored to the start of the name so "Share screen" does not also match the chat
 * panel's "Share a file with everyone".
 */
const SHARE_CONTROL_PATTERNS = [/^share screen/i, /^present now/i];

/**
 * The source Meet offers when it asks what to present.
 *
 * Only the whole-screen choice is taken. A tab or a window would need a window to
 * exist first, and the display holds exactly one — the browser's own.
 */
const SHARE_SOURCE_PATTERN = /^(your )?entire screen$/i;

/**
 * Meet's warning about presenting a display that contains the Meet window itself,
 * which is always true here: one virtual display, one browser on it.
 *
 * Left unanswered the warning covers the presentation, so this is part of starting
 * one rather than a nicety.
 */
const SELF_VIEW_CONFIRM_PATTERN = /^(show my screen anyway|share anyway|present anyway)$/i;

/** The control Meet only renders while a presentation is up — the proof it started. */
const STOP_SHARING_PATTERN = /^stop (sharing|presenting)/i;

/** How long to look for a share control, a source menu or the self-view warning. */
const SHARE_PROBE_MS = 2_000;

/** Cap on one click in the share flow. */
const SHARE_CLICK_TIMEOUT_MS = 3_000;

/**
 * How long to wait for the room to actually be seeing the screen.
 *
 * The capture needs no picker — a launch flag answers `getDisplayMedia` with the
 * virtual display — but Meet still renegotiates the call before it renders the
 * presenting state, and the self-view warning lands somewhere in the middle of that.
 */
const SHARE_CONFIRM_TIMEOUT_MS = 15_000;

/** Gap between "is it presenting yet?" reads while the share is being set up. */
const SHARE_CONFIRM_INTERVAL_MS = 1_000;

/**
 * What happened to the microphone on the way in.
 *
 * `confirmed` is the only load-bearing field: it says whether the room can hear us,
 * and it is deliberately *not* a veto — see `confirmAdmitted`. `mutedOnEntry` measures
 * how often the platform auto-mutes a joiner, and stays `false` when the toggle could
 * not be read at all, since a reading nobody took must not be filed as an auto-mute.
 */
interface MicOutcome {
  confirmed: boolean;
  mutedOnEntry: boolean;
}

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
  querySelectorAll(selectors: string): ArrayLike<CountElement>;
}

interface CountDocument {
  querySelector(selectors: string): CountElement | null;
  querySelectorAll(selectors: string): ArrayLike<CountElement>;
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

  /**
   * Load the meeting, once more if another navigation lands on top of it.
   *
   * Playwright rejects a `goto` that a *different* navigation interrupts, and one can
   * still be in flight from the sign-in that ran seconds earlier: Google's redirect
   * chains outlive the call that started them. The sign-in now parks the page before
   * handing it over, so this should be rare — but "rare" and "never" are different
   * things when the cost of being wrong is a user told their meeting link is broken.
   *
   * Only that one error is retried. Everything else — a dead link, a timeout, no
   * network — is a real answer and is reported as it stands.
   */
  private async loadMeetingPage(page: Page, url: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_READY_TIMEOUT_MS });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt > 1 || !/interrupted by another navigation/i.test(message)) throw err;
        logger.info('[Meeting] Another navigation landed on the meeting page — loading it again');
        // From a still page, or the interloper's next hop takes the retry down too and
        // reports the same misleading message this exists to prevent.
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10_000 })
          .catch(() => undefined);
      }
    }
  }

  private async attemptJoin(page: Page, options: JoinOptions): Promise<JoinOutcome> {
    try {
      await this.loadMeetingPage(page, options.url);
    } catch (err) {
      return { status: 'failed', step: 'page_load', reason: `Could not load the meeting page: ${err instanceof Error ? err.message : String(err)}` };
    }

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
      // One cause is worth telling apart from selector rot, because it is the one an
      // operator can fix: Meet offering to let us in without a microphone means it
      // found no working capture device, and its panel sits over the join button. That
      // used to be clicked, which got us into calls as a participant who could never
      // say anything; now it stops the join, so the reason had better name the mic
      // rather than blame the page.
      if (await this.noMicrophoneOffer(page)) {
        return {
          status: 'failed',
          step: 'microphone',
          reason:
            "Google Meet couldn't find a working microphone in my browser — it only " +
            'offered to let me in without one, which would have put me in the call ' +
            "unable to say anything, so I didn't join. The container's audio devices " +
            'are the place to look.',
        };
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
   * The browser grants its own permission prompt (see `browser-stack.ts`), but Meet
   * has its own "allow microphone" and "continue without" panels that sit on top of
   * the join UI.
   */
  private async dismissDeviceDialogs(page: Page): Promise<void> {
    // "Got it" dismisses the sign-in tooltip, which floats over the join column
    // and can otherwise intercept a click meant for the controls beneath it.
    //
    // "Continue without microphone" and "Continue without microphone and camera"
    // used to be on this list, and pressing them is how a bot ends up in a call
    // with no capture device — silent for the whole meeting, and past the point
    // where unmuting can help, because there is no device left to unmute. Meet only
    // offers them when it thinks the mic is unavailable; the answer is to let that
    // join fail loudly rather than to accept a mute we cannot recover from.
    const labels = ['Got it', 'Dismiss'];
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
   * Is Meet offering to let us in without a microphone?
   *
   * Read, never pressed — see `dismissDeviceDialogs`. Meet paints this offer when it
   * has no capture device to give the tab, and the panel carrying it sits over the
   * join button, so the visible symptom is a join that never finds its button. That
   * is a true observation and a useless report: it points at Meet's markup when the
   * fault is the container's audio devices.
   *
   * Text rather than a selector because the wording is what we actually know; the
   * panel's structure we do not. A miss just falls through to the generic message.
   */
  private async noMicrophoneOffer(page: Page): Promise<boolean> {
    try {
      const text = (await page.locator('body').innerText({ timeout: 2_000 })) ?? '';
      return /continue without (a )?microphone/i.test(text);
    } catch {
      return false;
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
   * Clear a modal off the call controls, pressing only buttons that just dismiss.
   *
   * Returns quietly when there is no dialog, which is the common case. When there is
   * one it doesn't recognise, it says so and leaves it: the click it would otherwise
   * guess at is the one that joins without a microphone. See `DIALOG_DISMISS_PATTERNS`.
   *
   * The button hunt is page-wide rather than scoped inside the dialog. Scoping reads
   * better but buys nothing here — the allowlist is anchored to whole names that only
   * ever mean "dismiss", so pressing one that belongs to something else on the page is
   * harmless, and the dialog is what we already know is on top.
   */
  private async dismissBlockingDialogs(page: Page): Promise<void> {
    const dialog = page.locator(BLOCKING_DIALOG_SELECTOR).first();

    for (let pass = 1; pass <= DIALOG_SWEEP_PASSES; pass += 1) {
      if (!(await appears(dialog, DIALOG_PROBE_MS))) return;

      for (const pattern of DIALOG_DISMISS_PATTERNS) {
        try {
          const button = page.getByRole('button', { name: pattern }).first();
          if (!(await appears(button, DIALOG_PROBE_MS))) continue;
          await button.click({ timeout: 2_000 });
          logger.info(`[Meeting] Cleared a dialog off the call controls (matched ${pattern})`);
          break;
        } catch {
          // Went stale mid-click, or something else took it — try the next phrasing.
        }
      }
    }

    // Judged on the dialog rather than on "did I click something", because the two
    // can disagree: the hunt is page-wide, so a match can belong to something else
    // entirely and leave the modal exactly where it was.
    if (await appears(dialog, DIALOG_PROBE_MS)) {
      logger.warn(
        '[Meeting] A dialog is still covering the call controls — either its buttons ' +
          'are not ones I will press, or clearing it did not work',
      );
    }
  }

  /**
   * Is the microphone muted? `null` means the toggle could not be read at all.
   *
   * Three-valued on purpose. "Couldn't read it" must not collapse into "it's fine":
   * that reading is what a rotted selector produces, and treating it as unmuted is
   * indistinguishable from success right up to the point where nobody can hear the
   * agent. Anything other than a literal `"false"` counts as muted for the same
   * reason — an attribute Meet renames is not permission to assume the best.
   */
  private async micMuted(page: Page, timeoutMs = MIC_TOGGLE_TIMEOUT_MS): Promise<boolean | null> {
    const toggle = page.locator(MIC_TOGGLE_SELECTOR).first();
    if (!(await appears(toggle, timeoutMs))) return null;
    try {
      const muted = await toggle.getAttribute('data-is-muted');
      if (muted === null) return null;
      return muted !== 'false';
    } catch {
      return null;
    }
  }

  /**
   * Get the microphone live, and report whether Meet had muted us.
   *
   * Meet auto-mutes a new joiner once a call is past a handful of participants, which
   * is exactly the meeting anyone bothers to send an agent to. Nothing downstream can
   * see it — admission, the participant count and the Realtime socket all read healthy
   * while the agent greets a room that hears nothing — so the unmute is part of getting
   * in, and what came of it is reported rather than assumed.
   *
   * This is the same click a human makes when Meet mutes them on the way in, and it
   * carries the same consequence: if it does not work, you are in a meeting nobody can
   * hear you in. What the agent does about that is `confirmAdmitted`'s business.
   */
  private async ensureMicOn(page: Page): Promise<MicOutcome> {
    const initial = await this.micMuted(page);

    if (initial === null) {
      logger.error(
        '[Meeting] Could not read the microphone toggle on the call UI — the Meet ' +
          'controls may have changed, and I cannot tell whether the room can hear me',
      );
      // Not filed as an auto-mute: this is a reading nobody took, and counting it would
      // inflate `muted_on_entry` in exactly the outage that produces it.
      return { confirmed: false, mutedOnEntry: false };
    }

    if (!initial) {
      logger.info('[Meeting] Microphone was already live on arrival');
      return { confirmed: true, mutedOnEntry: false };
    }

    logger.info('[Meeting] Meet put me in the call muted — unmuting');
    const deadline = Date.now() + MIC_PHASE_TIMEOUT_MS;
    for (let attempt = 1; attempt <= MIC_UNMUTE_ATTEMPTS && Date.now() < deadline; attempt += 1) {
      // Every attempt, not just the first: the dialog that eats the click can arrive
      // after the sweep, and a click that was swallowed leaves no trace beyond the
      // toggle not having moved.
      await this.dismissBlockingDialogs(page);

      try {
        await page.locator(MIC_TOGGLE_SELECTOR).first().click({ timeout: MIC_CLICK_TIMEOUT_MS });
      } catch (err) {
        // Reported rather than swallowed: "subtree intercepts pointer events" here is
        // the scrim, and it is the difference between a UI change and a covered button.
        logger.info(
          `[Meeting] Unmute attempt ${attempt} did not land: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }

      await page.waitForTimeout(MIC_SETTLE_MS);
      // The short patience: the toggle was found on the read above, so a confirmation
      // that has to wait ten seconds for it is waiting for something else.
      let after = await this.micMuted(page, MIC_RECHECK_MS);
      // "Couldn't read it" must not fall through to the next attempt as if it said
      // muted: if the click did land, clicking again would mute a microphone that is
      // now live — the original bug, re-entered through the retry. Pay the full
      // patience once before spending an attempt on it.
      if (after === null) after = await this.micMuted(page);
      if (after === false) {
        logger.info(`[Meeting] Microphone is live (took ${attempt} attempt(s))`);
        return { confirmed: true, mutedOnEntry: true };
      }
    }

    logger.error('[Meeting] Microphone is still muted after every attempt');
    return { confirmed: false, mutedOnEntry: true };
  }

  /**
   * Read the microphone without touching it. `null` when the control cannot be read.
   *
   * The short patience rather than `MIC_TOGGLE_TIMEOUT_MS`: this reads a call that is
   * already up, so a control that is not there now is not about to paint, and a
   * ten-second wait would hold a poll open for a reading it will take again anyway.
   */
  async microphoneLive(page: Page): Promise<boolean | null> {
    const muted = await this.micMuted(page, MIC_RECHECK_MS);
    return muted === null ? null : !muted;
  }

  /**
   * Put the microphone in the requested state, mid-call, and report what it reads.
   *
   * Thinner than `ensureMicOn`: one reading, and a click only if that reading disagrees
   * with the request. A `null` — the control not found — returns `null` without touching
   * anything, because this runs against a live call and a selector that has rotted would
   * otherwise become a clicker loose on Meet's control bar. The one-shot patience is
   * short for the same reason.
   *
   * Only a confirmed read is reported. An unreadable one must not come back as the
   * requested state — that is the reading a rotted selector gives, and it would silence
   * the retry and the warning together.
   */
  async setMicrophone(page: Page, on: boolean): Promise<boolean | null> {
    const muted = await this.micMuted(page, MIC_RECHECK_MS);
    if (muted === null) return null;
    const live = !muted;
    if (live === on) return live;

    await this.dismissBlockingDialogs(page);
    try {
      await page.locator(MIC_TOGGLE_SELECTOR).first().click({ timeout: MIC_CLICK_TIMEOUT_MS });
    } catch {
      // Still covered, or gone. Report the state read before the click, which disagrees
      // with the request, so the caller reads a failure. Safe even if the click did land:
      // the next call reads the new state and returns without clicking again.
      return live;
    }

    await page.waitForTimeout(MIC_SETTLE_MS);
    return this.microphoneLive(page);
  }

  /**
   * Post one message into the call's chat, and confirm the page took it.
   *
   * Meet publishes no chat API, so this is selector-matching against the in-call
   * panel — see `CHAT_TOGGLE_SELECTOR` and friends for how much of it one live call
   * measured, and what it did not.
   *
   * Which makes the failure direction the whole design. A `sent: true` here needs
   * three independent positives: the composer painted, the draft left it, and the text
   * turned up on the page *more times than before this send*. Every other path names
   * the step it stopped at and reports `sent: false`, so a rotted selector produces a
   * failure the agent then says out loud — recoverable — rather than a room that got
   * nothing while the agent believes otherwise. Nothing in this method turns a caught
   * error into a success.
   *
   * Every exit closes the panel again, best effort — see `closeChatPanel` for why a
   * failed send has to do that as carefully as a successful one.
   */
  async sendChatMessage(page: Page, text: string): Promise<ChatSendResult> {
    const toggle = await firstThatAppears(chatToggleCandidates(page), CHAT_PANEL_TIMEOUT_MS);
    if (!toggle) {
      return { sent: false, step: 'panel', reason: 'no chat control on the call page' };
    }

    const opened = await this.openChatPanel(page, toggle);
    if ('failure' in opened) {
      // Closed on this path too: `openChatPanel` reports `composer` after clicking the
      // panel open, so this is the failure that leaves a panel over the participant tiles.
      await this.closeChatPanel(toggle);
      return opened.failure;
    }
    const { composer } = opened;

    // Read before anything is typed. The confirmation is that this number went up, so
    // the baseline has to predate both the draft and the message: the same link posted
    // twice in one call would otherwise confirm the second send off the first one's
    // message, still sitting in the panel above it.
    const needle = text.slice(0, CONFIRM_NEEDLE_CHARS);
    const before = await this.settledCount(page, needle);
    if (before === null) {
      await this.closeChatPanel(toggle);
      return {
        sent: false,
        step: 'confirm',
        reason: 'the page could not be read before sending, so no send could be confirmed',
      };
    }

    try {
      await composer.fill(text, { timeout: CHAT_CLICK_TIMEOUT_MS });
    } catch (err) {
      await this.closeChatPanel(toggle);
      return {
        sent: false,
        step: 'composer',
        reason: `could not type into the chat box: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Enter is how Meet sends, and `fill` above put the text in as one operation, so
    // there is no keystroke to trip it early. The caller has already collapsed every
    // run of whitespace, so no newline can submit a fragment or split the message.
    try {
      await composer.press('Enter', { timeout: CHAT_CLICK_TIMEOUT_MS });
    } catch {
      // Fall through: the send button below is the other way in.
    }

    if (await this.confirmSent(page, composer, needle, before)) {
      await this.closeChatPanel(toggle);
      return { sent: true };
    }

    // One fallback, not a retry loop: a panel whose Enter handler moved still has a
    // send button, and pressing it is a different path rather than the same one again.
    const send = await firstThatAppears(chatSendCandidates(page), CHAT_SEND_PROBE_MS);
    if (!send) {
      await this.closeChatPanel(toggle);
      return { sent: false, step: 'send', reason: 'Enter did not send and there is no send button' };
    }

    try {
      await send.click({ timeout: CHAT_CLICK_TIMEOUT_MS });
    } catch (err) {
      await this.closeChatPanel(toggle);
      return {
        sent: false,
        step: 'send',
        reason: `the send button would not take a click: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const confirmed = await this.confirmSent(page, composer, needle, before);
    await this.closeChatPanel(toggle);
    return confirmed
      ? { sent: true }
      : {
          sent: false,
          step: 'confirm',
          reason: 'the page never showed the message as sent',
        };
  }

  /**
   * Get the panel open, and hand back the composer in it.
   *
   * Resolves the failure rather than a boolean, so the two reasons stay apart: a panel that
   * would not open is `panel`, a panel that painted no input is `composer`, and those are
   * different problems for whoever reads the telemetry.
   */
  private async openChatPanel(
    page: Page,
    toggle: Locator,
  ): Promise<{ composer: Locator } | { failure: ChatSendResult }> {
    if ((await this.panelIsOpen(toggle)) !== true) {
      // Same reason the unmute does this: a modal's scrim eats the click, and the
      // click reports success on the scrim rather than on the button underneath.
      await this.dismissBlockingDialogs(page);
      try {
        await toggle.click({ timeout: CHAT_CLICK_TIMEOUT_MS });
      } catch (err) {
        return {
          failure: {
            sent: false,
            step: 'panel',
            reason: `the chat control would not open: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    }

    // The first of the three positives a send needs: the composer painted. `appears`
    // waits; `isVisible` would not — see its docblock.
    const composer = await firstThatAppears(chatComposerCandidates(page), CHAT_PANEL_TIMEOUT_MS);
    if (!composer) {
      return {
        failure: { sent: false, step: 'composer', reason: 'the chat panel did not paint an input' },
      };
    }
    return { composer };
  }

  /**
   * Is the chat panel open? `true`, `false`, or null when the toggle will not say.
   *
   * `aria-expanded` on the toggle is the one piece of panel state Meet publishes, and it
   * answers immediately. The alternative is probing for the composer, which asks a
   * different question: a panel that is open but a render behind reads as closed, and the
   * probe then either clicks the panel shut or has to be short enough to race.
   */
  private async panelIsOpen(toggle: Locator): Promise<boolean | null> {
    try {
      const expanded = await toggle.getAttribute('aria-expanded', {
        timeout: CHAT_READ_TIMEOUT_MS,
      });
      if (expanded === null) return null;
      return expanded.trim().toLowerCase() === 'true';
    } catch {
      return null;
    }
  }

  /**
   * Close the panel again. Never changes the reported outcome.
   *
   * Not cosmetic, and not conditional on the send having worked: the panel shares the side
   * rail with People, `participantCount` reads participant tiles, and a count of one for a
   * minute is what makes the runtime leave the call. So every exit from a send comes
   * through here.
   *
   * Reads the state first, because the control is a toggle and something else can have
   * closed the panel already — the participants poll shares that rail, so a click landing
   * after it would *open* chat instead. A toggle that will not say gets the click: a panel
   * left open is the reading that costs the call, and clicking a closed panel open is what
   * the next poll undoes.
   */
  private async closeChatPanel(toggle: Locator): Promise<void> {
    if ((await this.panelIsOpen(toggle)) === false) return;
    try {
      await toggle.click({ timeout: CHAT_CLICK_TIMEOUT_MS });
    } catch {
      // Best effort. The next send opens it again, and the count poll tolerates a
      // reading it cannot take — it is a low reading that costs us.
    }
  }

  /**
   * Did the page take the message? Two readings, both required.
   *
   * Neither alone is worth anything. An empty composer on its own is what Meet shows
   * for a send the server then dropped. The text being on the page on its own is
   * *worse*: an unsent draft is still sitting in the composer, inside the panel, so a
   * containment test would match the exact failure it is meant to catch. Together they
   * mean the draft went somewhere and the text is in the room's message list — which is
   * read without a selector for that list, the most volatile node in the panel and the
   * one there is least evidence about.
   *
   * `before` is why this counts rather than contains. A containment test answers "is
   * this text on the page", which is already true of anything the agent posted earlier
   * in the call, so a second send of the same link would read as confirmed by the first
   * one's message. Counting answers "is there one more of it than there was", which
   * only the send can make true.
   *
   * The page-wide read is what `readRejection` already does, so its cost is known.
   *
   * Known false negative, unverified: a long message Meet renders collapsed behind a
   * "show more" could fail the count having actually been sent. 60 characters of a
   * message capped at 500 makes that unlikely, and it fails in the safe direction.
   */
  private async confirmSent(
    page: Page,
    composer: Locator,
    needle: string,
    before: number,
  ): Promise<boolean> {
    for (let read = 1; read <= CHAT_CONFIRM_READS; read += 1) {
      // The first look is immediate: a send that landed should not be made to wait an
      // interval before the agent may speak about it.
      if (read > 1) await page.waitForTimeout(CHAT_CONFIRM_INTERVAL_MS);

      if ((await this.readDraft(composer)) !== '') continue;
      const now = await this.countOnPage(page, needle);
      // A read that failed is not a reading of zero. There are more reads after it, and
      // then a reported failure.
      if (now !== null && now > before) return true;
    }

    return false;
  }

  /**
   * The baseline count, once it stops moving. Null if any read of it fails.
   *
   * The panel paints its history when it opens, and the composer can be there a moment
   * before the messages are. A baseline read in that moment is too low, and a message that
   * paints later — during the confirmation reads — then counts as this send: a success the
   * room never got. So the count has to agree with itself twice before anything is typed.
   *
   * Costs one extra read on a still panel, since the second read agrees with the first.
   */
  private async settledCount(page: Page, needle: string): Promise<number | null> {
    let last: number | null = null;
    for (let read = 1; read <= BASELINE_SETTLE_READS; read += 1) {
      if (read > 1) await page.waitForTimeout(BASELINE_SETTLE_INTERVAL_MS);
      const now = await this.countOnPage(page, needle);
      // Unreadable is fatal here rather than something to retry past: a baseline nobody
      // could take is what makes an unconfirmable send look confirmed.
      if (now === null) return null;
      if (now === last) return now;
      last = now;
    }
    // Still moving after that many reads. The newest reading is the best there is, and the
    // other two positives a send needs still have to hold on top of it.
    return last;
  }

  /**
   * How many times `needle` appears in the page's text, or null when it cannot be read.
   *
   * Null rather than 0 for an unreadable page: 0 is a number the caller compares, and a
   * busy page must not be able to make a count look like it went up.
   */
  private async countOnPage(page: Page, needle: string): Promise<number | null> {
    try {
      const pageText = await page.locator('body').innerText({ timeout: CHAT_READ_TIMEOUT_MS });
      return pageText.split(needle).length - 1;
    } catch {
      return null;
    }
  }

  /**
   * What is still in the composer, or `'unknown'` when it cannot be read.
   *
   * `inputValue()` throws on a contenteditable, which is one of the shapes the composer
   * locator accepts, so `innerText` is the fallback. An unreadable box answers
   * `'unknown'` rather than `''`: only a box confirmed empty may contribute to a
   * success, and "I could not look" is not that.
   */
  private async readDraft(composer: Locator): Promise<string> {
    try {
      return (await composer.inputValue({ timeout: CHAT_READ_TIMEOUT_MS })).trim();
    } catch {
      try {
        return (await composer.innerText({ timeout: CHAT_READ_TIMEOUT_MS })).trim();
      } catch {
        return 'unknown';
      }
    }
  }

  /**
   * Report the admission, with what became of the microphone attached.
   *
   * Both admission paths go through here so neither can grow an `admitted` that never
   * tried the microphone at all — the unmute is part of getting in, not something the
   * call does later.
   *
   * A microphone it could not confirm is **not** a failed join. The agent hears the
   * room through a different device entirely (`meet_out.monitor`, nothing to do with
   * the mic), so a muted agent is still a listener with its full tool surface, and
   * leaving would throw that away. It is also a scraped DOM attribute: taking Google
   * renaming it as grounds to abandon meetings would turn a cosmetic UI change into a
   * total outage. So this reports what it knows and lets the runtime tell somebody —
   * which is the property the veto was really after, without the amputation.
   */
  private async confirmAdmitted(page: Page): Promise<JoinOutcome> {
    const mic = await this.ensureMicOn(page);

    if (!mic.confirmed) {
      logger.warn(
        '[Meeting] Joining with a microphone I could not confirm is live — the room ' +
          'may hear nothing from me',
      );
    }

    return {
      status: 'admitted',
      mutedOnEntry: mic.mutedOnEntry,
      micConfirmed: mic.confirmed,
    };
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
        return this.confirmAdmitted(page);
      }

      const rejection = await this.confirmedRejection(page);
      if (rejection) {
        // Confirming takes a couple of seconds, and admission can land inside that
        // window. Being in the room outranks any text on it.
        if (await this.isInCall(page)) {
          logger.info('[Meeting] Admitted while a rejection message was being confirmed');
          return this.confirmAdmitted(page);
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

  /**
   * In-call furniture — the closest thing Meet gives us to an "admitted" flag.
   *
   * Two more markers used to be listed here, `button[aria-label*="People"]` and
   * `[data-participant-count]`. A live probe of every `aria-label` on the page found neither,
   * which is the same finding that removed them from `participantCount` — and here they were
   * not merely inert: each one costs its own 400ms wait on the *not* in-call path, which is
   * the path every admission poll and every rejection check takes.
   */
  private async isInCall(page: Page): Promise<boolean> {
    const markers = ['button[aria-label*="Leave call" i]', 'button[aria-label*="Leave meeting" i]'];
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
      const { resolveDataDir } = await import('../../../../lib/data-dir');
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
   * Who is in the room, as far as the panel will say.
   *
   * Read from the participants panel and nowhere else. Each row's `aria-label` *is* the
   * person's name, so nothing has to be recovered from it — which the previous version did,
   * because it read the video tiles. A tile renders its name twice with a control label glued
   * on ("Mario SarcherMario Sarcherdevices"), and un-gluing that was guesswork that had
   * already eaten a real name once, turning "Miska" into "M" and handing the transcriber a
   * single letter to bias towards.
   *
   * Why names are worth reading at all is observed rather than theoretical: one call rendered
   * "Miska" as "Mees", "Max" as "Mark", and a third participant's name in Japanese
   * characters. Names are the words a meeting transcript is worst at and the ones this
   * feature most depends on — the gate's clearest refusals are of the form "the speaker
   * addresses Isaac", which only holds when Isaac survives transcription.
   *
   * Empty on any failure, including a panel that is not open. A missing hint costs accuracy
   * and nothing else: the transcriber keeps the agent's own name, and the addressed gate
   * judges the audio with no roster to check it against.
   */
  async participantNames(page: Page): Promise<string[]> {
    return namesFrom(await readRoom(page)).filter(plausibleName);
  }

  async enableSpeakerAttribution(page: Page): Promise<void> {
    await openParticipants(page);
  }

  async currentSpeaker(page: Page): Promise<SpeakerReading | null> {
    const reading = await readRoom(page);
    return reading === null ? null : judgeSpeaker(reading);
  }

  /**
   * Present the virtual display into the call.
   *
   * Meet asks for up to three clicks: the share control, a menu that asks which source,
   * and a warning about presenting a screen that holds the meeting window. It does not
   * always ask for all three. So this clicks each control that is there, and needs none
   * of them.
   *
   * The result comes from the "Stop sharing" control. Meet shows that control only while
   * a presentation runs, so it is the one reading that is not cosmetic.
   *
   * Chromium answers the capture picker itself — a launch flag selects the virtual
   * display (see `browser-stack.ts`).
   */
  async startScreenShare(page: Page): Promise<ScreenShareOutcome> {
    if (await this.findControl(page, [STOP_SHARING_PATTERN])) return { status: 'already_sharing' };

    await this.dismissBlockingDialogs(page);

    const control = await this.findControl(page, SHARE_CONTROL_PATTERNS);
    if (!control) {
      return { status: 'failed', reason: "I could not find Meet's screen-sharing control." };
    }

    try {
      await control.click({ timeout: SHARE_CLICK_TIMEOUT_MS });
    } catch {
      return {
        status: 'failed',
        reason: "Meet's screen-sharing control would not take a click.",
      };
    }

    const source = await this.findControl(page, [SHARE_SOURCE_PATTERN]);
    if (source) {
      try {
        await source.click({ timeout: SHARE_CLICK_TIMEOUT_MS });
      } catch {
        // The menu closed itself, or the choice moved. Whether that mattered is
        // decided below, by the room rather than by this click.
      }
    }

    const deadline = Date.now() + SHARE_CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // Swept on every pass rather than once: the warning lands somewhere inside the
      // renegotiation, and while it is up it covers the presentation.
      const anyway = await this.findControl(page, [SELF_VIEW_CONFIRM_PATTERN]);
      if (anyway) {
        try {
          await anyway.click({ timeout: SHARE_CLICK_TIMEOUT_MS });
          logger.info('[Meeting] Confirmed the self-view warning');
        } catch {
          // Somebody's click won the race, or it repainted. Read the state below.
        }
      }

      if (await this.findControl(page, [STOP_SHARING_PATTERN])) {
        logger.info('[Meeting] Sharing the screen');
        return { status: 'sharing' };
      }

      await page.waitForTimeout(SHARE_CONFIRM_INTERVAL_MS);
    }

    logger.warn('[Meeting] Asked Meet to share the screen, but it never started presenting');
    return {
      status: 'failed',
      reason: 'I asked Meet to share the screen and it never started presenting.',
    };
  }

  /**
   * Stop presenting.
   *
   * The control that shows a share is running is also the control that ends it. So no
   * control means there is nothing to stop, and the result comes from that control
   * disappearing rather than from the click.
   */
  async stopScreenShare(page: Page): Promise<ScreenShareOutcome> {
    const stop = await this.findControl(page, [STOP_SHARING_PATTERN]);
    if (!stop) return { status: 'not_sharing' };

    try {
      await stop.click({ timeout: SHARE_CLICK_TIMEOUT_MS });
    } catch {
      return { status: 'failed', reason: "Meet's stop-sharing control would not take a click." };
    }

    const deadline = Date.now() + SHARE_CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await this.findControl(page, [STOP_SHARING_PATTERN]))) {
        logger.info('[Meeting] Stopped sharing the screen');
        return { status: 'stopped' };
      }
      await page.waitForTimeout(SHARE_CONFIRM_INTERVAL_MS);
    }

    logger.warn('[Meeting] Asked Meet to stop sharing, and it is still presenting');
    return { status: 'failed', reason: 'I asked Meet to stop sharing and it is still presenting.' };
  }

  /**
   * The first control matching any of these names, or null.
   *
   * Buttons and menu items are searched together because Meet renders these choices as
   * one or the other, and every caller here wants whichever it turns out to be. The
   * patterns are anchored by their authors for the reason
   * `DIALOG_DISMISS_PATTERNS` is: this clicks things on a live call, and a loose match
   * on a control bar full of verbs is how a share tool stops a share.
   */
  private async findControl(page: Page, patterns: RegExp[]): Promise<Locator | null> {
    for (const name of patterns) {
      const control = page
        .getByRole('button', { name })
        .or(page.getByRole('menuitem', { name }))
        .first();
      if (await appears(control, SHARE_PROBE_MS)) return control;
    }
    return null;
  }

  /**
   * Read the participant count from the UI, the agent included.
   *
   * Two things ride on this: leaving once the room has emptied, and deciding whether the
   * agent answers everything or waits to be addressed. It is therefore read three ways and
   * the **largest** reading wins, because the two failure directions are not equally bad.
   * Reading high costs one person having to say the agent's name; reading low puts a silent
   * agent back to answering every sentence in a room full of people, which is the bug this
   * exists to prevent. Returns null only when nothing could be read at all — never a guess,
   * since the caller must not eject the agent from a call that is still going.
   *
   * All three readings are checked against a live call rather than taken from documentation.
   * Two that the first version relied on, `[data-participant-count]` and a
   * `button[aria-label*="People"]`, are gone: Meet renders neither, and a probe of every
   * `aria-label` on a live page matched nothing /people/i except "Chat with everyone".
   * What is left, in order of how much it can be trusted:
   *
   * 1. **Panel rows.** Exact and language-independent, but only while the panel is open.
   * 2. **The People control's count badge.** Meet's own number, and readable with the panel
   *    shut, which is what keeps the empty-room check working when the panel will not open.
   *    English, and so the one reading a differently-localised profile loses.
   * 3. **Distinct participant ids anywhere in the page.** Language-independent, and the last
   *    thing standing if the panel is shut *and* the control is relabelled. It under-reports
   *    when Meet virtualizes off-screen tiles, which is why the largest wins.
   */
  async participantCount(page: Page): Promise<number | null> {
    let readings: number[];
    try {
      // One `evaluate` rather than a locator per strategy: this runs on a timer for the
      // whole call, and three locator round-trips each with their own timeout is a lot of
      // work to repeat every ten seconds.
      readings = await withTimeout(
        page.evaluate(() => {
          const doc = (globalThis as unknown as { document: CountDocument }).document;

          const found: number[] = [];
          const add = (value: number) => {
            if (Number.isFinite(value) && value > 0) found.push(value);
          };

          const panel = doc.querySelector('[role="list"][aria-label="Participants"]');
          if (panel) {
            add(
              Array.from(panel.querySelectorAll('[role="listitem"][aria-label]')).filter((row) =>
                row.getAttribute('data-participant-id'),
              ).length,
            );
          }

          // The People control renders its label and a count badge as separate nodes, so
          // the control's combined text reads "People2". Matched on that text rather than a
          // class name, because every class on that subtree is a generated hash that
          // changes without notice — and the control has no aria-label of its own.
          for (const el of Array.from(doc.querySelectorAll('div,span,button'))) {
            const text = el.textContent?.trim() ?? '';
            if (text.length > 24) continue;
            const badge = text.match(/^people\s*(\d{1,4})$/i);
            if (badge) add(parseInt(badge[1], 10));
          }

          // Distinct ids, because the same participant appears both as a tile and as a
          // panel row once the roster is open.
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
