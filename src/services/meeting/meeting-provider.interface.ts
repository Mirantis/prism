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
 * Who a voice belongs to, as far as the platform can say.
 *
 * Two cases rather than one shape with optional fields, because they are answered
 * differently and a caller has to handle both. `person` is somebody who can be named and
 * addressed. `group` is one microphone several people share — any room system mixes the
 * people in front of it, and the platform can then only say that the group made a sound.
 *
 * A group carries no name on purpose. The platform's label for it ("Merged audio" on
 * Meet) is a piece of its own UI and not somebody who can be spoken to, so an agent that
 * reads it out is talking to a person who does not exist. `members` is the useful answer
 * instead — best effort, and empty when the platform mixes people without saying which.
 */
export type SpeakerDetails =
  | { kind: 'person'; name: string }
  | { kind: 'group'; members: readonly string[] };

/**
 * Who the platform last showed as speaking.
 *
 * `id` is what callers compare, and never a name: two participants can share a display
 * name, a display name can change mid-call, and "was that the same person as before?" has
 * to be exact. On Meet it is the per-device path off the participants panel, and a merged
 * group's own identity is as sound as an individual's.
 *
 * `isSelf` is separate because "that was the agent" and "nobody can be identified" are
 * different answers, and a caller that folds them together keeps reporting a stale human
 * as the floor holder for the whole time the agent is talking.
 */
export interface SpeakerReading {
  id: string;
  isSelf: boolean;
  who: SpeakerDetails;
}

/**
 * Where a chat send got to before it stopped.
 *
 * Bounded, for the same reason as `JoinStep`: it is emitted as telemetry, and the
 * message body must never be. `panel` is no chat control on the page, `composer` is
 * a panel that painted no input, `send` is an input nothing will submit, and
 * `confirm` is a submit the page never showed as sent.
 */
export type ChatSendStep = 'panel' | 'composer' | 'send' | 'confirm';

/**
 * Outcome of posting one message into the call's own chat.
 *
 * `sent: true` is a positive reading, never the absence of an error. A provider that
 * cannot tell whether the message left says `sent: false` — the room hearing nothing
 * while the agent reports success is the failure this shape exists to prevent.
 */
export type ChatSendResult =
  | { sent: true }
  /** `step` is what telemetry gets; `reason` is what a human reads in a log. */
  | { sent: false; step: ChatSendStep; reason: string };

/**
 * What became of a request to start or stop presenting.
 *
 * One type for both directions. Both answer the same question: what the room sees now.
 * `already_sharing` and `not_sharing` are separate from `sharing` and `stopped` because
 * the agent says them differently. One announces a change, the other corrects somebody
 * about the state.
 */
export type ScreenShareOutcome =
  | { status: 'sharing' | 'already_sharing' | 'stopped' | 'not_sharing' }
  | { status: 'failed'; reason: string };

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
   * Is the microphone live? `true` live, `false` muted, `null` unreadable.
   *
   * A read, and only a read — this must never click anything. The runtime asks on its
   * participant poll and keeps the answer, so `meeting_status` reports a call nobody can
   * hear without reading the page mid-turn.
   *
   * `null` must not collapse into either answer. "Couldn't read it" is what a rotted
   * selector produces, and reporting it as live is indistinguishable from a healthy
   * call right up to the point where nobody can hear the agent.
   *
   * Optional: a platform whose microphone state cannot be read offers none of this.
   */
  microphoneLive?(page: Page): Promise<boolean | null>;

  /**
   * Turn the microphone on or off, and report the state that was last read.
   *
   * Same three values as `microphoneLive`, and for the same reason: the caller decides
   * whether the request was met by comparing the reading with what it asked for, rather
   * than trusting a boolean that cannot tell "it is off now" from "I could not tell".
   *
   * Must not click a control it cannot read. The toggle is a *toggle*, so acting on an
   * uncertain reading is how a retry mutes a microphone that had just come on; "I don't
   * know" has to mean "leave it alone and answer `null`". A state that already matches
   * the request is reported, not clicked.
   *
   * Optional, and paired with `microphoneLive`: the runtime clicks before it settles for
   * reading, so a platform offering only the read never reports on a call it could not
   * make audible.
   */
  setMicrophone?(page: Page, on: boolean): Promise<boolean | null>;

  /**
   * Post one short plain-text message into the call's own chat.
   *
   * Speech stays the only way anything reaches the agent; this is one channel out,
   * for what does not survive being spoken — a URL, an identifier, a command.
   *
   * **Must confirm, not assume.** Resolve `sent: true` only on a positive reading
   * that the page took the message: the composer emptied *and* the text appeared in
   * the panel. A selector that has rotted looks exactly like a message that went
   * through, so every path that cannot read the outcome resolves `sent: false` with
   * the step it stopped at. The caller reports a failure to the model, which then
   * says so out loud — recoverable. A false success is not.
   *
   * The caller normalizes and length-checks the text first, so this receives a
   * single-line string it can submit as-is.
   *
   * Optional: a platform with no chat panel, or none a browser can drive, omits it.
   */
  sendChatMessage?(page: Page, text: string): Promise<ChatSendResult>;

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
   * no speaker has ever been read. That is the same shape as `setMicrophone`, and for the
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
   * It is not handed the roster to check a name against. A caption scrape needed that,
   * because a caption line and a fragment of a sentence are indistinguishable by shape.
   * Reading the participant list directly removes the ambiguity rather than compensating
   * for it: a row's own label cannot be a sentence fragment, and the identity attribute
   * beside it is a second structural check.
   */
  currentSpeaker?(page: Page): Promise<SpeakerReading | null>;

  /**
   * Start presenting into the call, best effort.
   *
   * The room sees the whole display the browser runs on, not one window, because the
   * capture is a screen. So the thing to show has to be the window on top.
   *
   * Reports a failure instead of throwing, as `join` does: a control that moved is
   * something to say in the room, not a stack trace. Optional, so a platform that
   * cannot present omits it.
   */
  startScreenShare?(page: Page): Promise<ScreenShareOutcome>;

  /**
   * Stop presenting, best effort.
   *
   * Answers `not_sharing` when there was no presentation to stop. That is a fact about
   * the room, not an error: the share may have been stopped from the platform's own
   * controls, or never have started.
   *
   * Any provider that implements `startScreenShare` implements this too. A share that
   * nothing can end lasts for the whole call.
   */
  stopScreenShare?(page: Page): Promise<ScreenShareOutcome>;

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
