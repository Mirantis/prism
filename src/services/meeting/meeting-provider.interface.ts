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
  /** In the room — audio flows from here, in at least one direction. */
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
       *
       * `false` when the control could not be read at all — a reading nobody took
       * is not evidence of an auto-mute, and counting it would inflate the number
       * during precisely the outage that produces it.
       */
      mutedOnEntry: boolean;
      /**
       * Whether the room can actually hear us.
       *
       * Separate from `status` on purpose, and the distinction matters: an agent
       * that cannot speak still hears the meeting and keeps its whole tool surface,
       * so being inaudible is a degraded call rather than a failed one. The runtime
       * says so — to the user, and to the model, which would otherwise spend the
       * call talking to a room that hears nothing.
       */
      micConfirmed: boolean;
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

/**
 * Who the platform last showed as speaking.
 *
 * `id` is what callers compare, and `name` is only ever for people to read — a log line,
 * or telling the agent who asked it something. Two participants can share a display name,
 * a display name can change mid-call, and "was that the same person as before?" has to be
 * exact, so an identity the platform assigns is the only sound basis for it. On Meet that
 * is the per-device path off the participants panel.
 *
 * `isSelf` is separate because "that was the agent" and "nobody can be identified" are
 * different answers, and a caller that folds them together keeps reporting a stale human
 * as the floor holder for the whole time the agent is talking.
 */
export interface SpeakerReading {
  id: string;
  name: string;
  isSelf: boolean;
  /**
   * Several people sharing one audio source, rather than one person.
   *
   * Not a Meet quirk: any room system mixes the people in front of it, and the platform
   * can then only say the group made a sound. Worth a flag of its own because `name` is a
   * *label* in that case ("Merged audio") and not somebody who can be addressed — a
   * caller that reads it out has the agent talking to a person who does not exist. As an
   * identity it is perfectly sound, so the same-speaker test needs no special case.
   */
  isGroup: boolean;
  /**
   * Who shares the microphone, when `isGroup`. Absent otherwise.
   *
   * Part of describing a group rather than a separate question, so it costs no second read.
   * `name` on its own is a platform label, and while an agent can say something true with it
   * ("I can't tell who spoke, it was the merged audio"), naming the two people who actually
   * share the microphone is more use to the room. Best effort: a platform that mixes people
   * without saying which of them may leave this empty.
   */
  members?: readonly string[];
}

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
   * **A platform that auto-mutes new joiners must unmute, and must say whether it
   * worked.** Meet does this once a call is past a handful of participants. Getting
   * in muted is not a failed join — the agent still hears the room and keeps every
   * tool it has — but it is invisible from the inside, and that is the part a
   * provider cannot leave to the runtime: admission, the participant count and the
   * Realtime socket all read perfectly healthy while the room hears nothing. So
   * unmute, then report `micConfirmed` honestly, including `false` when the control
   * could not be read. Never infer it from the absence of evidence: a selector that
   * has rotted looks exactly like a microphone that is already fine.
   *
   * Whether the capture device then actually opens is the runtime's half of the
   * check — the provider owns the browser, not the audio stack.
   */
  join(page: Page, options: JoinOptions): Promise<JoinOutcome>;

  /**
   * Try again to get the microphone live, mid-call. `true` when it is confirmed.
   *
   * The runtime calls this on its existing participant poll while `micConfirmed` is
   * false, which is what a human does when they notice they are muted: click it, and
   * click it again later. Without it, one unlucky moment during admission — a dialog
   * that outlived the sweep, a control bar still painting — would cost the whole
   * meeting, and the note the user got would be true for an hour rather than for a
   * few seconds.
   *
   * Must not click a control it cannot read. The toggle is a *toggle*, so acting on an
   * uncertain reading is how a retry mutes a microphone that had just come on; "I
   * don't know" has to mean "leave it alone and answer false".
   *
   * Optional: a platform that never mutes a joiner needs none of this.
   */
  ensureUnmuted?(page: Page): Promise<boolean>;

  /**
   * Names of the people in the call, best effort, empty when unavailable.
   *
   * Optional because it is a hint rather than a mechanism: a platform that cannot
   * offer it still works, just with a transcriber that has never been told how the
   * room's names are spelled.
   */
  participantNames?(page: Page): Promise<string[]>;

  /**
   * Put the platform's UI into whatever state lets speech be attributed to a speaker.
   *
   * **Must not reject**, and must be safe to call repeatedly. The runtime calls it once
   * immediately after a successful join — before the agent has a voice, so before anything
   * could be attributed — and then keeps calling it on the participant poll for as long as
   * no speaker has ever been read. That is the same shape as `ensureUnmuted`, and for the
   * same reason: one unlucky moment while the control bar is still painting would otherwise
   * cost attribution for the whole meeting, silently.
   *
   * Whether such state survives between calls is the platform's business, and Meet's does
   * not — its participants panel starts shut, and with it shut the roster is not in the
   * page at all — so the runtime asks on every join rather than once per profile. A
   * provider that needs no such preparation may simply not implement this.
   */
  enableSpeakerAttribution?(page: Page): Promise<void>;

  /**
   * Who the platform last showed as speaking, or null when it cannot be told.
   *
   * The audio a meeting bot receives is one mixed channel, so this is the only route to
   * attribution — and it is a *hint*: it lags real speech, it stops working if the UI
   * moves, and a platform need not offer it at all. Nothing may become unsafe when it
   * returns null; a caller that cannot work without a speaker has to fall back to
   * behaving as though the room were anonymous, which is what it did before.
   *
   * It used to be handed the roster, so that a scraped label could be checked against who
   * was actually in the call — a caption line and a fragment of a sentence being
   * indistinguishable by shape. Reading the participant list directly removes the
   * ambiguity rather than compensating for it: a row's own label cannot be a sentence
   * fragment, and the identity attribute beside it is a second structural check. So the
   * parameter is gone.
   */
  currentSpeaker?(page: Page): Promise<SpeakerReading | null>;

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
