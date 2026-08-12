/**
 * The extension seam for meeting platforms.
 *
 * Almost nothing about a voice meeting is Google-specific: the virtual audio
 * devices, the Realtime session, barge-in and the tool bridge are all the same
 * whether the call is on Meet, Teams or Zoom. What differs is a browser flow —
 * which buttons to press to get in, how to tell you were admitted, how to know
 * the room emptied, and how to leave.
 *
 * A provider therefore owns exactly that and nothing else. Adding Teams means
 * writing one of these, registering it, and adding a `join_msteams_meeting` tool;
 * no part of the audio or model path needs to know a second platform exists.
 */

import type { Page } from 'playwright-core';

/**
 * Where a join attempt got to before it stopped.
 *
 * A bounded enum rather than the prose reason, because it is emitted as telemetry:
 * it answers "which step is failing in production" without carrying page text. The
 * `reason` stays the thing a human reads.
 */
export type JoinStep = 'page_load' | 'lobby' | 'join_button' | 'admission' | 'microphone';

/** Outcome of trying to get into a call. */
export type JoinOutcome =
  /** In the room, unmuted — audio flows from here. */
  | {
      status: 'admitted';
      /**
       * Whether the platform had us muted on arrival, before the provider unmuted.
       *
       * Carried on the outcome rather than read back afterwards because it is a
       * fact about the join that stops being observable the moment it is fixed.
       * Emitted as telemetry: how often a platform auto-mutes new joiners is what
       * says whether this whole step still earns its keep, and it is the number
       * whose absence let a permanently silent bot go unnoticed.
       */
      mutedOnEntry: boolean;
    }
  /** A host actively refused, or the waiting room timed out. */
  | { status: 'denied'; reason: string; step: JoinStep }
  /** Never got as far as the waiting room (bad link, meeting over, UI changed). */
  | { status: 'failed'; reason: string; step: JoinStep }
  /**
   * The credentials we hold were not accepted, and signing in again may fix it.
   *
   * Platform-neutral by intent — an expired SSO session on Teams is the same shape.
   *
   * Worth its own outcome because it is the one failure that heals itself: sign in
   * again and the same link works. Previously the join went ahead as an anonymous
   * guest, which Meet auto-denies — so a recoverable stale cookie cost a page load,
   * a lobby wait and a refusal, and only recovered if the agent happened to try
   * again. Observed three times in one afternoon on a profile whose own account
   * page still loaded, so it is routine rather than exotic.
   */
  | { status: 'reauth_required' };

export interface JoinOptions {
  url: string;
  /**
   * Cap on the waiting room, measured from the moment the join request goes in.
   *
   * Reaching the lobby is budgeted separately: charging page load and the join-button
   * hunt to this number let a slow lobby report "nobody admitted the request" without
   * the provider having waited even once.
   */
  admissionTimeoutMs: number;
}

export interface MeetingProvider {
  /** Stable identifier, used in tool names, logs and telemetry. */
  readonly name: string;

  /** Human-readable platform name for messages to the user. */
  readonly displayName: string;

  /**
   * Why this provider cannot run at all right now, or null when it can.
   *
   * Asked before a call's worth of infrastructure is built. Google Meet answers
   * when no account is configured: it denies an automated anonymous guest before a
   * host is ever prompted, so that join cannot succeed, and discovering it in the
   * lobby costs a virtual display, an audio daemon, a browser and a metered
   * Realtime socket first.
   *
   * The provider answers rather than the runtime because only it knows what it
   * needs — the lifecycle owner should not be reading one platform's credentials.
   */
  configurationError(): string | null;

  /**
   * Authenticate the browser profile, if the platform needs it.
   *
   * **Must not reject.** A failed sign-in is non-fatal by design: whether the
   * browser is signed in is decided by the profile's cookies, not by this call's
   * opinion of them, and a check reporting a challenge for a session that then
   * worked is something we have watched happen. Refusing a join on it would refuse
   * joins that succeed.
   *
   * `force` skips any "am I already signed in?" probe. The caller passes it after a
   * `reauth_required`, where that probe is precisely what was wrong.
   */
  signIn?(page: Page, options?: { force?: boolean }): Promise<void>;

  /** Whether this provider handles the given link. */
  matchesUrl(url: string): boolean;

  /**
   * Drive the browser from a blank page into the meeting.
   *
   * Resolves with the outcome rather than throwing for the expected endings
   * (denied, timed out) — those are meeting facts to report to the user, not
   * errors. Throwing is reserved for genuine breakage.
   *
   * **`admitted` means the room can hear us.** A platform that auto-mutes new
   * joiners — Meet does, once a call is past a handful of participants — must
   * unmute before reporting success, and report `failed` with step `microphone`
   * if it cannot. This is a contract rather than an implementation detail because
   * getting it wrong is invisible from the inside: the bot sits in the call
   * greeting a room that hears nothing, and every signal the runtime watches
   * (admission, participant count, the Realtime socket) looks perfectly healthy.
   * Whether the capture device then actually opens is the runtime's half of the
   * check — the provider owns the browser, not the audio stack.
   */
  join(page: Page, options: JoinOptions): Promise<JoinOutcome>;

  /**
   * Names of the people in the call, best effort, empty when unavailable.
   *
   * Optional because it is a hint rather than a mechanism: a platform that cannot
   * offer it still works, just with a transcriber that has never been told how the
   * room's names are spelled.
   */
  participantNames?(page: Page): Promise<string[]>;

  /**
   * How many people are in the call, or null when it can't be determined.
   *
   * Used to leave automatically once the bot is the only one left. Null is
   * treated as "don't know, stay" — a UI change should not eject the bot from a
   * live meeting.
   */
  participantCount(page: Page): Promise<number | null>;

  /** Leave the call, best effort — the browser is closed right after. */
  leave(page: Page): Promise<void>;
}
