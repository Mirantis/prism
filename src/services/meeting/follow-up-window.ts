/**
 * Staying in an exchange without being named again.
 *
 * `response-policy.ts` records a 15-second grace period that was built, tested on real
 * calls, and removed: fifteen seconds after the agent stops talking is mostly people
 * starting to talk to *each other*, and an unattributed window answered them. Everything
 * below exists because that failure is real and because the fix is not a shorter timer.
 *
 * What makes this version a different design rather than the same one with a smaller
 * number: it knows **who** is speaking. With a speaker identity from the platform's own
 * participants panel (`providers/google-meet/participants.ts`), the window can be about one
 * person continuing one exchange instead of about a span of time in which anybody may say
 * anything.
 *
 * Four conditions, all required, and each of them earned:
 *
 *   1. **The same speaker** who was last answered as addressed. Someone else talking is
 *      not a follow-up, whatever they say.
 *   2. **Within the window** of the agent's own turn ending — not of the utterance that
 *      armed it, since what the speaker is following up on is the answer.
 *   3. **Not addressed to anybody else.** Being inside the window means that person is
 *      still talking, not that they are still talking *to the agent*. Live, the same
 *      speaker turned to a colleague inside the window ("Tom, do you know the default
 *      port for MySQL?") and the agent answered it.
 *   4. **Question- or request-shaped.** A statement, or a "right, let's move on", is the
 *      exchange ending rather than continuing.
 *
 * **Failing any of them silences nothing.** The utterance falls through to the ordinary
 * model gate, exactly as it does today. All this window can do is grant permission to
 * skip that call, so its own failure mode is latency — never an utterance the agent
 * should have answered and didn't.
 *
 * **Only the finished sentence is judged, in either direction.** A partial transcript is
 * incomplete by definition, and acting on one is wrong both ways round.
 *
 * Closing on a partial shut the window mid-request on a live call — an unfinished sentence
 * reads as a statement:
 *
 *     partial: "Now, we want to talk about, about, you know..."   → looked like a statement
 *     final:   "...can you put together an agenda for that?"      → obviously a follow-up
 *
 * Accepting on one is the same mistake wearing a friendlier face. "And what do you think"
 * passes every test here, and the sentence it turns out to belong to is "...about the
 * rollout, Pamela?" — so the answer is locked in before the words that say who it was for
 * have arrived. A finished transcript follows the speaker stopping by a few hundred
 * milliseconds, and the model call is skipped either way, so that margin is the whole cost.
 *
 * **A known limit.** The speaker this compares against is a snapshot, and it lags
 * the words: the poll adds up to a second, and a gate verdict arrives about 1.3 seconds
 * after the sentence it judged. A speaker change
 * inside that skew can arm the window for the wrong person, or offer one person's words as
 * another's follow-up. The freshness bound in `VoiceConversation` handles a *stale* reading,
 * not a skewed one, and nothing local can — it is a property of reading attribution off a UI
 * rather than off the audio.
 *
 * **Another person speaking deliberately does not close it.** That rule was tried and
 * removed. People interleave constantly, so a single "yeah" from the other participant
 * shut the window and whoever had actually addressed the agent could no longer follow up —
 * one accepted follow-up in six minutes, against four in the minute after it was taken out.
 * It was also redundant, since condition 1 already declines anybody else. A graduated
 * version, where a substantive turn closes and a backchannel does not, is here but off by
 * default: the word threshold has never been sized against real voices.
 */

import { logger } from '../../logger';
import { addressedToSomeoneElse } from './vocative';

/** Why a window stopped being open. Bounded, and reported as telemetry. */
export type FollowUpCloseReason =
  /** Somebody said something that was not a question or a request. */
  | 'shape'
  /** Somebody named a person who is not the agent. */
  | 'vocative'
  /** Somebody asked the room rather than the agent. */
  | 'group'
  /** Nothing followed up in time. */
  | 'clock';

export interface FollowUpWindowOptions {
  /** How long after the agent's turn ends a follow-up still counts. `0` disables all of this. */
  windowMs: number;
  /** What the room calls the agent — needed to tell its own name from a third party's. */
  agentName: string;
}

export interface FollowUpWindowStats {
  /** Utterances answered as follow-ups, with no model call. */
  accepted: number;
  /** Windows closed, by reason. */
  closedBy: Record<FollowUpCloseReason, number>;
}

/**
 * Questions thrown at the room rather than at one person.
 *
 * A closed class of fixed expressions, which is why a list is the right shape here — there
 * is no morphology to get wrong, and the tagger has nothing to say about them (it reads
 * "Guys" and "Folks" as proper nouns, so grammar alone would take them for names).
 *
 * Counted apart from a named third party because they are a different mistake. Live, "Any
 * takes from the team?" was accepted 813ms after the agent's turn and answered, while the
 * model gate had correctly declined a sibling utterance with "The speaker is addressing the
 * group" — the window was weaker than the gate it exists to skip.
 *
 * Bare `team` and `guys` were in this list and had to come out: "can you ask the platform
 * team to bump the quota?" is a request *to the agent*, and it closed the exchange on the
 * word `team`. The two-word forms keep the sense and avoid the collision.
 */
/**
 * Utterance start times held at once, before the lot is dropped.
 *
 * A cheap bound rather than careful bookkeeping: the map is cleared at every exchange
 * boundary anyway, and losing a start time only costs one follow-up its latency.
 */
const UTTERANCE_CLOCKS_KEPT = 32;

/** How a follow-up's start reads in the log, since it can precede the end of the answer. */
function describeStart(since: number): string {
  return since < 0 ? `${-since}ms before my turn ended` : `${since}ms after my turn`;
}

const GROUP_VOCATIVE =
  /\b(the team|you guys|everyone|everybody|all of you|the room|anyone else|folks)\b/i;

/** Openers that make an utterance a question even without a question mark on the end. */
const QUESTION_OPENER =
  /^(what|where|when|why|how|who|which|can|could|would|will|do|does|did|is|are|any)\b/i;

/**
 * A continuation opening with "and", which only counts when a question follows it.
 *
 * Bare `and` was in the list above and accepted plain statements: "And I think we should
 * just move on." and "And that is why we missed the deadline." were both answered, and the
 * same token stopped a statement from ever closing the window. Requiring what follows to be
 * a question word or an auxiliary keeps the case this exists for — "and what about staging",
 * "and can you check the logs" — and drops the rest.
 */
const AND_QUESTION =
  /^and\s+(what|where|when|why|how|who|which|can|could|would|will|do|does|did|is|are|any)\b/i;

/**
 * Ways of asking for something that are not shaped like a question.
 *
 * Anchored, which they were not. `please` anywhere accepted "right, let us move on please"
 * — the exact "let's move on" this design says must close the window — and `tell me`
 * anywhere accepted "I asked Bob and he would not tell me anything", which is reported
 * speech. A request is an imperative, so it opens the sentence.
 */
const REQUEST_PHRASE = /^(please\b|could you\b|can you\b|would you\b|tell me\b|show me\b|give me\b)/i;

/**
 * Being handed the floor back, which is a request to speak while asking nothing.
 *
 * From a live call: the agent was cut off mid-answer, and the person who cut it off said
 * "Go ahead, sorry." four seconds later. Nothing about that is question- or request-shaped, so
 * the window declined it and the room got silence from an agent that had just been invited to
 * carry on. It happened twice — an earlier bare "Go ahead." was declined too, and the speaker
 * had to say the agent's name to prompt it.
 *
 * Tested per clause, because it arrives wrapped in apology on both sides: "Oh, go ahead" and
 * "go ahead, sorry" alike. `HORTATIVE` is checked first, so "let's carry on" still reads as
 * moving the group along rather than as an invitation.
 */
const INVITATION = /^(go ahead|go on|carry on|continue|after you|you were saying)\b/i;

/**
 * The speaker moving the group along, which is the exchange ending rather than continuing.
 *
 * Its own test because it survives every other one: "let us move on" is an imperative, so
 * it reads as a request, and adding `please` to it made it read as a polite one.
 */
const HORTATIVE = /^(let'?s|let us)\b/i;

/**
 * Words below which a statement is a noise rather than the exchange ending.
 *
 * Now that anybody may follow up, anybody's "yeah" reaches the shape test — and a statement
 * closes the window. That is the failure the old `MEETING_FOLLOW_UP_OTHER_SPEAKER_CLOSES`
 * existed to avoid, measured at one accepted follow-up in six minutes against four in the
 * minute after it was switched off. So the graduated rule that knob described became
 * unconditional instead of being deleted with it: a short statement is declined and leaves the
 * window open, a substantial one ends the exchange.
 *
 * Six words, which is where that knob's threshold sat. It has never been sized against real
 * voices, and as a *non-closing* bound its failure direction is mild — an exchange lingers to
 * its clock instead of ending on somebody muttering, and the window can only ever add an
 * answer.
 */
const BACKCHANNEL_WORDS = 6;

/**
 * An utterance's sentences, for the anchored patterns above to be tried against.
 *
 * Plain punctuation rather than the POS tagger's splitter: this runs on every considered
 * utterance and needs no tags, and the tagger is already loaded for the guard that does.
 */
function clausesOf(text: string): string[] {
  return text
    .split(/[,.?!;]+\s*/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Why an utterance is not a continuation, and whether that ends the exchange. */
interface Drift {
  reason: FollowUpCloseReason;
  detail: string;
  /** False when the verdict is "cannot tell" rather than "the exchange has moved on". */
  closes: boolean;
}

export class FollowUpWindow {
  /** Whether an exchange is under way at all. */
  private armed = false;
  /**
   * Who the agent was answering when this exchange began, for the log only.
   *
   * Not a condition any more. The window used to require a follow-up to come from this same
   * person, and two people in a call asked for that to go: "it would feel more natural if anybody can keep
   * going with the agent, and only after somebody else's name is mentioned would it be
   * disabled." So eligibility is now about what is said rather than who says it, and the drift
   * guards — a question or request, aimed at nobody else, not thrown at the room — make the
   * whole decision.
   *
   * Two things follow. A backchannel from another person can no longer close an exchange, so
   * `MEETING_FOLLOW_UP_OTHER_SPEAKER_CLOSES` and its word threshold are gone rather than
   * merely off — everyone is eligible, and what they say decides. And the window no longer
   * depends on speaker attribution at all, so it keeps working on a call where the participants
   * panel cannot be read; attribution's remaining job is telling the agent who it is talking
   * to, through `meeting_speaker`.
   */
  private armedBy: string | null = null;
  /** When the agent's own turn ended. The window is measured from here, not from the request. */
  private turnEndedAt = 0;
  private closed = false;
  private roster: readonly string[] = [];
  /**
   * When each utterance in this exchange started, by item id.
   *
   * The window's clock is judged against this rather than against the moment a transcript
   * finishes, because otherwise a follow-up is penalised for being *long*. Measured live: the
   * speaker began 2.3s after the agent stopped — plainly a follow-up — took about seven
   * seconds to ask their question, and was declined because the eight seconds ran out while
   * they were still talking.
   *
   * Acceptance still needs the finished sentence; that guard is about what was said, not when.
   * Conflating the two is what produced the bug.
   *
   * Cleared only when a new exchange is armed, never on the agent's turn starting: that runs
   * on every chunk of audio reaching the room, and clearing there wiped the stamp of any
   * utterance already under way. A stale entry is harmless — item ids are unique, so nothing
   * consults one twice — and the size cap bounds the map regardless.
   */
  private startedAt = new Map<string, number>();
  private readonly stats: FollowUpWindowStats = {
    accepted: 0,
    closedBy: { shape: 0, vocative: 0, group: 0, clock: 0 },
  };

  constructor(private readonly options: FollowUpWindowOptions) {}

  get statistics(): FollowUpWindowStats {
    return { accepted: this.stats.accepted, closedBy: { ...this.stats.closedBy } };
  }

  /** True while a follow-up could still be accepted. Read by tests and by `[Meeting]` logs. */
  get isOpen(): boolean {
    return (
      this.options.windowMs > 0 &&
      !this.closed &&
      this.armed &&
      this.turnEndedAt > 0 &&
      Date.now() - this.turnEndedAt <= this.options.windowMs
    );
  }

  /**
   * The agent has just answered somebody as having addressed it.
   *
   * Armed on **any** addressed verdict, from either path, rather than on the name appearing
   * in the words. Requiring the literal name was tried and was wrong in the room: "...the
   * reason why I asked you to join, Max" was judged addressed and answered but carried no
   * name, so nothing armed, and the natural next question — "Can you start to explain him
   * the overall concept of Lens Agents?" — was declined. The operator's words: "that was
   * already a miss because it should have been answering to that even without the name."
   *
   * `null` when the platform could not say who spoke, which leaves the feature inert rather
   * than guessing. That is what `attribution_rate` measures.
   */
  arm(speaker: string | null): void {
    if (this.options.windowMs <= 0) return;
    this.armed = true;
    this.armedBy = speaker;
    this.closed = false;
    this.startedAt.clear();
    // The previous exchange's clock must go with it. Left in place, anything said between
    // this arming and the agent's *next* turn ending — a backchannel from anyone during a
    // ten-second answer, which is routine — was measured against a timestamp from the last
    // exchange, fired a clock-close, and killed the follow-ups of an exchange that had not
    // even started. It also put a phantom count into the close telemetry this window is
    // meant to be tuned by.
    this.turnEndedAt = 0;
  }

  /**
   * The agent has started a turn. Nothing counts as a follow-up until it ends.
   *
   * Without this the window has no idea the agent is mid-answer, and everything said over
   * it is judged against the *previous* turn's clock. In a chained exchange — a follow-up
   * answered, then another — that is a live timestamp, so a same-speaker "yeah, got it"
   * while the agent is still talking one-strike closed the window before the answer it was
   * reacting to had finished.
   */
  onAgentTurnStarted(): void {
    this.turnEndedAt = 0;
  }

  /** Tell the window who is in the call, so a lower-cased name is still recognised. */
  setRoster(roster: readonly string[]): void {
    this.roster = roster;
  }

  /**
   * The agent's turn is over — it finished speaking, or was cut off.
   *
   * Measured from here rather than from the request that prompted it, because a follow-up
   * follows the *answer*. An interruption counts too: somebody who cut the agent off is
   * plainly still in the exchange.
   */
  onAgentTurnEnded(): void {
    if (!this.armed) return;
    this.turnEndedAt = Date.now();
  }

  /**
   * Should this utterance be answered as a continuation of the exchange?
   *
   * Closes the window as a side effect when the exchange has visibly ended. Synchronous,
   * because `ResponsePolicy.onTranscript` is — see the note on the tagger in `vocative.ts`.
   */
  consider(transcript: string, stage: 'partial' | 'final', itemId: string): boolean {
    if (this.options.windowMs <= 0 || this.closed || !this.armed) return false;

    // Stamped on first sight, which is a partial for anything longer than a word or two —
    // and stamped **before** the suspension check below, because when somebody started
    // talking has nothing to do with whether the agent was talking at the time.
    //
    // Putting it after that check was a bug with the same shape as the one this whole clock
    // exists to fix. People begin their follow-up while the answer is still winding down: in
    // a measured call the first partial arrived 8.3s in, with the agent still speaking, so no
    // stamp was taken; the finished sentence then stamped itself at its own end, 8.4s after
    // the turn, and the clock closed on a follow-up that had begun before the answer ended.
    let startedAt = this.startedAt.get(itemId);
    if (startedAt === undefined) {
      startedAt = Date.now();
      if (this.startedAt.size >= UTTERANCE_CLOCKS_KEPT) this.startedAt.clear();
      this.startedAt.set(itemId, startedAt);
    }

    if (this.turnEndedAt === 0) return false;

    // Negative when they began before the agent finished, which is inside any window.
    const since = startedAt - this.turnEndedAt;
    if (since > this.options.windowMs) {
      // Reporting the gap that was actually observed, not just the bound that was exceeded.
      // There is deliberately no timer here — the clock is evaluated when somebody next speaks,
      // which is correct (nothing can be accepted in between, and `isOpen` computes it live)
      // but means this line can appear long after the exchange really lapsed. One log line read
      // "nothing followed up within 8000ms" eighty seconds late and cost two wrong readings of
      // what had happened. A timer would fix the timestamp and buy nothing else.
      this.close(
        'clock',
        `nothing followed up within ${this.options.windowMs}ms — the next thing said came ` +
          `${(since / 1000).toFixed(1)}s after my turn`,
      );
      return false;
    }

    // Judged only on the finished sentence, in both directions.
    //
    // Accepting from a partial was tried and is unsafe in a way accepting early *sounds*
    // like it should not be: the shape test passes on "And what do you think", the answer is
    // locked in and the item marked handled, and then the sentence finishes "...about the
    // rollout, Pamela?" — which was never for the agent. Condition 3 can flip with the rest
    // of a sentence in a way condition 4 cannot. Since a finished transcript arrives within
    // a few hundred milliseconds of the speaker stopping, all this costs is that margin,
    // and a model call is still skipped either way.
    if (stage !== 'final') return false;

    const drift = this.driftReason(transcript);
    if (drift === null) {
      this.stats.accepted += 1;
      logger.info(
        `[Meeting:FollowUp] answering without a gate call — same speaker, started ${describeStart(since)}`,
      );
      return true;
    }

    if (drift.closes) this.close(drift.reason, drift.detail);
    return false;
  }

  /**
   * Why this is not a continuation of the exchange, or null when it is.
   *
   * Order matters: who it was aimed at is asked before what shape it has, because "Tom, do
   * you know the port?" is question-shaped and still not for the agent.
   */
  private driftReason(transcript: string): Drift | null {
    const other = addressedToSomeoneElse(transcript, this.options.agentName, this.roster);
    if (!other.read) {
      // No verdict, so no licence to skip the model call — and no grounds to close either.
      // Not being able to read a sentence is not the same as the exchange having ended, so
      // this leaves the window open for the finished transcript or the next sentence.
      // Reached when the tagger is unavailable, or the words are in a script it cannot read.
      return { reason: 'shape', detail: 'could not read the sentence', closes: false };
    }
    if (other.name !== null) {
      return { reason: 'vocative', detail: 'aimed at somebody else', closes: true };
    }
    if (GROUP_VOCATIVE.test(transcript)) {
      return { reason: 'group', detail: 'aimed at the room', closes: true };
    }

    const text = transcript.trim();

    // Tested per *clause*, not per utterance. Anchored to the whole thing it missed
    // "right, let us move on" — five words, so the backchannel bound below would then have let
    // it pass as noise, when moving the group along is the clearest end an exchange has. A
    // clause edge rather than anywhere, because "can you let us know?" is a request and would
    // match a loose test.
    if (clausesOf(text).some((clause) => HORTATIVE.test(clause))) {
      return { reason: 'shape', detail: 'moving the group along', closes: true };
    }

    // Asked of each sentence, not of the utterance as a whole. The agent declined "There should
    // be some data folder, I think, or is it in slash app? It's in slash data, I think, yeah.
    // Check that" — a request whose question sits in the first sentence and whose imperative
    // sits in the last, so an utterance-level test saw a middle that ends on neither and
    // closed the exchange. The speaker noticed before I did: "that was weird, probably because
    // it was a statement and not a question."
    //
    // The patterns stay anchored, which is what makes this safe rather than looser: they were
    // anchored so `please` and `tell me` could not match deep inside reported
    // speech, and a sentence boundary is the smallest unit that keeps that true. Only the
    // *asking* test moves — the closing tests still read the whole utterance, because a rule
    // that ends an exchange should not get easier to trip.
    // A request or an invitation is matched per *clause*; a question per sentence, because a
    // question mark ends a sentence and not a clause.
    //
    // Per clause because a request arrives behind a filler. Scoring 19 labelled utterances
    // from real calls found "Okay, please go ahead." declined: `REQUEST_PHRASE` starts with
    // `please` and `INVITATION` with `go ahead`, and both were anchored to the sentence, which
    // starts with "Okay,". The anchoring still does its job, which was to keep `please` and
    // `tell me` from matching deep inside a sentence: "right, let us move on please" and
    // "I asked Bob and he would not tell me anything" open no clause with either phrase.
    const asking =
      clausesOf(text).some(
        (clause) => INVITATION.test(clause) || REQUEST_PHRASE.test(clause),
      ) ||
      sentencesOf(text).some(
        (sentence) =>
          /\?\s*$/.test(sentence) ||
          QUESTION_OPENER.test(sentence) ||
          AND_QUESTION.test(sentence),
      );
    if (asking) return null;

    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < BACKCHANNEL_WORDS) {
      return {
        reason: 'shape',
        detail: `a ${words}-word interjection rather than a follow-up`,
        closes: false,
      };
    }
    return { reason: 'shape', detail: 'a statement rather than a follow-up', closes: true };
  }

  private close(reason: FollowUpCloseReason, detail: string): void {
    this.closed = true;
    this.stats.closedBy[reason] += 1;
    logger.info(`[Meeting:FollowUp] window closed — ${detail}`);
  }
}
