/**
 * Staying in an exchange without being named again.
 *
 * `response-policy.ts` records a 15-second grace period that was built, tested on real calls,
 * and removed: fifteen seconds after the agent stops talking is mostly people starting to talk
 * to *each other*, and an unattributed window answered them. Everything below exists because
 * that failure is real and because the fix is not a shorter timer.
 *
 * What makes this version a different design rather than the same one with a smaller number:
 * it knows **who** is speaking. With a speaker identity from the platform's own participants
 * panel (`providers/google-meet/participants.ts`), the window can be about one person
 * continuing one exchange instead of about a span of time in which anybody may say anything.
 *
 * This class now decides **timing, and only timing**. Three conditions, all of them clocks:
 *
 *   1. **An exchange is under way** — the agent answered somebody who had addressed it.
 *   2. **The utterance began inside the window**, measured from the agent's own turn ending
 *      rather than from the utterance that armed it, since what a speaker follows up on is
 *      the answer.
 *   3. **The sentence has finished.** A partial is incomplete by definition.
 *
 * Whether the words are *for the agent* is `follow-up-judge.ts`'s question, asked of a model
 * with the recent transcript in front of it. It used to be answered here, by hand-written
 * sentence rules, and that could not be made to work: the sentence does not carry who it was
 * said to. On three real meeting transcripts the rules accepted 10.9% of ordinary meeting
 * speech; the model with six lines of context accepts 6.7%, and each rule that was added to
 * close a live failure exposed the next one.
 *
 * **A decline no longer ends the exchange.** With rules, one remark that expected no answer
 * closed the window, because a rule reading a single sentence cannot tell "the exchange is
 * over" from "that particular sentence wanted nothing". The judge reads each utterance against
 * the transcript, so it can decline one and accept the next. Only the clock closes a window
 * now.
 *
 * **Declining silences nothing.** Everything this window and that judge turn down falls
 * through to the ordinary addressed gate. All the window can do is grant permission to skip
 * that call, so its failure mode is latency — never an utterance the agent should have
 * answered and didn't.
 *
 * Accepting on a partial was tried and is unsafe in a way that acting early *sounds* like it
 * should not be. "And what do you think" reads as a follow-up, the answer is locked in and the
 * item marked handled, and then the sentence finishes "...about the rollout, Pamela?" — which
 * was never for the agent. A finished transcript follows the speaker stopping by a few hundred
 * milliseconds, so that margin is the whole cost.
 *
 * **A known limit.** The speaker this arms for is a snapshot, and it lags the words: the poll
 * adds up to a second, and a gate verdict arrives about 1.3 seconds after the sentence it
 * judged. A speaker change inside that skew can arm the window for the wrong person. The
 * freshness bound in `VoiceConversation` handles a *stale* reading, not a skewed one, and
 * nothing local can — it is a property of reading attribution off a UI rather than off the
 * audio.
 */

import { logger } from '../../logger';

export interface FollowUpWindowOptions {
  /** How long after the agent's turn ends a follow-up still counts. `0` disables all of this. */
  windowMs: number;
}

export interface FollowUpWindowStats {
  /** Utterances answered as continuations of an exchange, with nobody saying the name. */
  accepted: number;
  /**
   * Utterances the clock allowed that the exchange did not answer: the judge turned them
   * down, or its verdict arrived too late to act on. Both go on to the addressed gate, so
   * this costs latency rather than an answer — and the ratio against `accepted` is what says
   * whether an exchange is worth judging at all.
   */
  declined: number;
  /** Exchanges that ended because nothing followed up in time. */
  lapsed: number;
}

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










export class FollowUpWindow {
  /** Whether an exchange is under way at all. */
  private armed = false;
  /**
   * Who the agent was answering when this exchange began, for the log only.
   *
   * Not a condition. The window used to require a follow-up to come from this same person,
   * and two people in a call asked for that to go: "it would feel more natural if anybody can
   * keep going with the agent, and only after somebody else's name is mentioned would it be
   * disabled." So eligibility is about what is said rather than who says it.
   *
   * Two things follow. A backchannel from another person cannot close an exchange, so
   * `MEETING_FOLLOW_UP_OTHER_SPEAKER_CLOSES` and its word threshold are gone rather than
   * merely off. And the window does not depend on speaker attribution at all, so it works on
   * a call whose participants panel cannot be read — the judge reads the labels when they are
   * there and the words alone when they are not. Attribution's remaining job is telling the
   * agent who it is talking to, through `meeting_speaker`.
   */
  private armedBy: string | null = null;
  /** When the agent's own turn ended. The window is measured from here, not from the request. */
  private turnEndedAt = 0;
  private closed = false;
  /** How late the eligible utterance began, for the log line after the judge answers. */
  private eligibleAt = 0;
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
  private readonly stats: FollowUpWindowStats = { accepted: 0, declined: 0, lapsed: 0 };

  constructor(private readonly options: FollowUpWindowOptions) {}

  get statistics(): FollowUpWindowStats {
    return { ...this.stats };
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
    logger.info(
      `[Meeting:FollowUp] exchange open — ${speaker === null ? 'speaker unattributed' : `armed by ${speaker}`}`,
    );
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
   * Is this utterance eligible for the exchange, on the clock alone?
   *
   * Everything here is timing, and timing is all this class decides now. Whether the words are
   * aimed at the agent is `follow-up-judge.ts`'s question, because a set of hand-written
   * sentence rules could not answer it: the sentence does not carry who it was said to.
   *
   * Eligible does not mean answered. The caller asks the judge next, and a decline leaves the
   * window open — each utterance is judged on its own, with the transcript in front of it, so
   * one remark that expects no answer no longer ends an exchange. Only the clock does that.
   */
  eligible(stage: 'partial' | 'final', itemId: string): boolean {
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
        `nothing followed up within ${this.options.windowMs}ms — the next thing said came ` +
          `${(since / 1000).toFixed(1)}s after my turn`,
      );
      return false;
    }

    // Only the finished sentence is judged. A partial was tried and is unsafe in a way that
    // accepting early *sounds* like it should not be: "And what do you think" reads as a
    // follow-up, the answer is locked in and the item marked handled, and then the sentence
    // finishes "...about the rollout, Pamela?" — which was never for the agent. A finished
    // transcript arrives a few hundred milliseconds after the speaker stops, so all this
    // costs is that margin.
    if (stage !== 'final') return false;

    this.eligibleAt = since;
    return true;
  }

  /** The judge said yes. Counted and logged here so both stay next to the clock they used. */
  accept(): void {
    this.stats.accepted += 1;
    logger.info(
      `[Meeting:FollowUp] answering as a continuation — started ${describeStart(this.eligibleAt)}`,
    );
  }

  /**
   * The judge said no, or said yes too late to be worth acting on. The exchange stays open,
   * deliberately.
   *
   * One sentence that wants no answer is not the end of a conversation, and the judge is the
   * only thing here that can tell the two apart — it reads the utterance against the
   * transcript, so the next one gets judged on its own merits. The rule set this replaced had
   * to close, since a single sentence read alone cannot support that distinction.
   */
  decline(): void {
    this.stats.declined += 1;
  }

  private close(detail: string): void {
    this.closed = true;
    this.stats.lapsed += 1;
    logger.info(`[Meeting:FollowUp] window closed — ${detail}`);
  }
}
