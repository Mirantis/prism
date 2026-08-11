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
export type JoinStep = 'page_load' | 'lobby' | 'join_button' | 'admission';

/** Outcome of trying to get into a call. */
export type JoinOutcome =
  /** In the room — audio flows from here. */
  | { status: 'admitted' }
  /** A host actively refused, or the waiting room timed out. */
  | { status: 'denied'; reason: string; step: JoinStep }
  /** Never got as far as the waiting room (bad link, meeting over, UI changed). */
  | { status: 'failed'; reason: string; step: JoinStep }
  /**
   * The profile believed it was signed in and the platform disagreed.
   *
   * Worth its own outcome because it is the one failure that heals itself: sign in
   * again and the same link works. Previously the join went ahead as an anonymous
   * guest, which Meet auto-denies — so a recoverable stale cookie cost a page load,
   * a lobby wait and a refusal, and only recovered if the agent happened to try
   * again. Observed three times in one afternoon on a profile whose own account
   * page still loaded, so it is routine rather than exotic.
   */
  | { status: 'stale_session' };

export interface JoinOptions {
  url: string;
  /** Name shown to the other participants. */
  displayName: string;
  /**
   * Cap on the waiting room, measured from the moment the join request goes in.
   *
   * Reaching the lobby is budgeted separately: charging page load and the join-button
   * hunt to this number let a slow lobby report "nobody admitted the request" without
   * the provider having waited even once.
   */
  admissionTimeoutMs: number;
  /**
   * Whether the browser profile is signed into a Google account.
   *
   * Lets a provider tell two very different situations apart. Meet offers a guest
   * name field both to an anonymous visitor *and* to a signed-in one whose meeting
   * has ended — so seeing that field while signed in is strong evidence the link is
   * dead, not that sign-in failed. Without this the two look identical in the logs,
   * which cost real debugging time.
   */
  signedIn?: boolean;
  /**
   * Why signing in failed, when an account *was* configured.
   *
   * Meet refuses automated anonymous guests behind the same wall it shows for an
   * ended meeting and a dead link, so without this the runtime reported an expired
   * bot password as "the meeting has ended" — knowing the real answer and not saying
   * it. Absent when sign-in succeeded, or when no account is configured at all
   * (joining as a guest is then a deliberate choice, not a failure).
   */
  signInFailureReason?: string;
}

export interface MeetingProvider {
  /** Stable identifier, used in tool names, logs and telemetry. */
  readonly name: string;

  /** Human-readable platform name for messages to the user. */
  readonly displayName: string;

  /**
   * Whether the platform refuses an unauthenticated bot outright.
   *
   * Google Meet does: an automated anonymous guest is denied before a host is
   * prompted, so a join without an account is not a join that might fail — it is one
   * that cannot succeed. The runtime checks this before building a call's worth of
   * infrastructure. A platform that admits named guests leaves it false and uses
   * `JoinOptions.displayName`.
   */
  readonly requiresSignIn: boolean;

  /** Whether this provider handles the given link. */
  matchesUrl(url: string): boolean;

  /**
   * Drive the browser from a blank page into the meeting.
   *
   * Resolves with the outcome rather than throwing for the expected endings
   * (denied, timed out) — those are meeting facts to report to the user, not
   * errors. Throwing is reserved for genuine breakage.
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
