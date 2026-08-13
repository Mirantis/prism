/**
 * Should the agent answer *this* utterance?
 *
 * The Realtime API can decide that for us — `turn_detection.create_response`
 * opens a response at the end of every utterance — and in a room with more than
 * one human that is exactly wrong: the meeting audio is a single mixed channel,
 * so "someone finished a sentence" says nothing about who they were talking to.
 * A call with three people in it had the agent answering questions the humans
 * were asking each other.
 *
 * So the server never creates responses on its own (`create_response: false`)
 * and this object decides instead. Two modes, chosen from the participant count:
 *
 * - **open** — one human in the room, so everything said is said to the agent.
 *   It answers on end-of-utterance, before any transcript exists. That matters:
 *   it is the same instant the server would have created the response itself, so
 *   a one-to-one call is no slower than it was with the API driving.
 * - **addressed** — more than one human, so the agent has to be called by name,
 *   every time. Whether it was is decided by `addressed-classifier.ts`, not by
 *   matching the string: transcription mangles names ("Prism" came back as
 *   "Pritham"), an agent can be called anything, and a name can be mentioned
 *   without being addressed ("I asked Prism about that yesterday").
 *
 * Deliberately *not* judged: whether a sentence merely sounds like a request for
 * an assistant. The room is one mixed channel with no speaker labels, so "can you
 * add apples to the list?" is identical whether it was said to the agent or to the
 * person in the next chair. Guessing there is how a meeting bot ends up in the
 * middle of other people's conversations.
 *
 * **No grace period after the agent speaks.** An earlier version kept a 15-second
 * window in which any utterance counted as addressed, so a follow-up needn't
 * repeat the name. Testing on real calls killed it: fifteen seconds after the
 * agent stops talking is mostly other people starting to talk to *each other*,
 * which is the exact failure this file exists to prevent. Being named every time
 * is slightly more effort to talk to and much harder to get wrong, and it leaves
 * one rule to explain instead of three interacting ones.
 *
 * Every "yes" from this object *will* be spoken: unlike prompt-level gating there
 * is no path for the model to decline once `response.create` goes out. That makes
 * false positives the failure mode to design against.
 */

import { logger } from '../../logger';

/** What the caller asked for. `auto` resolves from the participant count. */
export type ResponseMode = 'auto' | 'open' | 'addressed';

/** What the policy is actually doing right now. */
export type EffectiveMode = 'open' | 'addressed';

/**
 * What to do with an utterance once its words are known.
 *
 * `classify` means this object declines to decide: whether the agent was named is
 * a judgement, and judgements live outside a class the rest of the code calls
 * synchronously.
 */
export type TranscriptDecision = 'respond' | 'ignore' | 'classify';

/**
 * Which transcript a verdict was judged from.
 *
 * `partial` is a guess made while the speaker is still talking; `final` is the
 * finished sentence, and the authoritative one.
 */
export type TranscriptStage = 'partial' | 'final';

/** Item ids remembered for the duplicate check. Bounded; turns are short-lived. */
const HANDLED_ITEM_LIMIT = 32;

export interface ResponsePolicyOptions {
  mode: ResponseMode;
}

export interface ResponsePolicyStats {
  /** Utterances the room produced (committed by the turn detector). */
  utterances: number;
  /** Of those, the ones the agent answered. */
  answered: number;
  /** Of those, the ones it stayed quiet through. */
  suppressed: number;
  /** Answers in `addressed` mode — times the agent was called by name. */
  addressedMatches: number;
  /**
   * How often the effective mode changed during the call.
   *
   * Usually people joining or leaving, but a call the agent cannot be heard in also
   * holds it in `addressed` — counted the same, because the two paths can each undo the
   * other and a tally that saw only one of them would report an odd number of switches
   * for a call that ended in the mode it started in.
   */
  modeSwitches: number;
}

export class ResponsePolicy {
  /**
   * Starts `addressed` rather than `open` when nothing is known yet.
   *
   * A count arrives moments after admission, so this covers a scraper that can't
   * read the UI at all. Guessing `open` there would put the original bug back in
   * a full room; guessing `addressed` costs a one-to-one caller one spoken name.
   */
  private mode: EffectiveMode = 'addressed';
  /**
   * Whether the room can hear the agent at all.
   *
   * Only `open` mode cares. `open` answers every utterance at its turn boundary,
   * which is right when one human is talking to the agent and ruinous when nothing
   * the agent says arrives: a full Realtime response per sentence, for the length of
   * the call, all of it billed and none of it heard. `addressed` is already bounded
   * by somebody choosing to say the agent's name, and staying responsive there is
   * deliberate — a muted agent still *acts* on what it is asked, and the action lands
   * even when the confirmation does not.
   */
  private audible = true;
  /** An id-less utterance was answered at the boundary; see `onTranscript`. */
  private answeredIdlessInOpenMode = false;
  private readonly handledItems: string[] = [];
  private readonly stats: ResponsePolicyStats = {
    utterances: 0,
    answered: 0,
    suppressed: 0,
    addressedMatches: 0,
    modeSwitches: 0,
  };

  constructor(private readonly options: ResponsePolicyOptions) {
    if (options.mode !== 'auto') this.mode = options.mode;
  }

  get effectiveMode(): EffectiveMode {
    return this.mode;
  }

  get statistics(): ResponsePolicyStats {
    return { ...this.stats };
  }

  /**
   * Take a participant-count reading (including the agent itself).
   *
   * `null` means the UI could not be read, which is never a reason to change
   * behaviour — the last known mode stands. Ignored entirely unless the caller
   * asked for `auto`.
   */
  /**
   * Say whether the room can hear the agent.
   *
   * Gates the *transition* into `open` rather than filtering its decisions, so
   * `mode` stays the one answer to "how am I behaving" and nothing downstream has to
   * ask a second question. Recovery restores whatever the mode would have been: an
   * `auto` policy gets it back from the next count reading seconds later, an explicit
   * one from the option it was built with.
   */
  setAudible(audible: boolean): void {
    if (audible === this.audible) return;
    this.audible = audible;

    if (!audible) {
      if (this.mode === 'open') {
        this.mode = 'addressed';
        this.stats.modeSwitches += 1;
        logger.info('[Meeting] Nothing I say is reaching the room — answering only when addressed');
      }
      return;
    }

    if (this.options.mode !== 'auto' && this.mode !== this.options.mode) {
      this.mode = this.options.mode;
      this.stats.modeSwitches += 1;
      logger.info(`[Meeting] The room can hear me again — back to "${this.mode}" mode`);
    }
  }

  setParticipantCount(count: number | null): void {
    if (count === null || this.options.mode !== 'auto') return;
    // Nothing the agent says is arriving, so `open` would answer a room that hears
    // none of it. Held here rather than at the decision sites so `mode` remains the
    // single description of how the agent is behaving.
    if (!this.audible) return;

    // The agent is one of them, so two means one human: everything said in the
    // room is said to the agent.
    const next: EffectiveMode = count <= 2 ? 'open' : 'addressed';
    if (next === this.mode) return;

    this.mode = next;
    this.stats.modeSwitches += 1;
    logger.info(
      `[Meeting] ${count} participant(s) — answering ` +
        (next === 'open' ? 'everything said in the room' : 'only when addressed'),
    );
  }

  /**
   * Count an utterance the caller is answering without asking this object first.
   *
   * The held-answer path decides at the transcript and speaks at the boundary, so
   * it never routes through `onUtteranceCommitted` — and without this the same
   * utterance was counted as answered but never as spoken, letting `answered`
   * climb past `utterances` and corrupting the suppressed/utterances ratio that is
   * the point of the stats.
   */
  noteUtterance(): void {
    this.stats.utterances += 1;
  }

  /**
   * The turn detector closed an utterance.
   *
   * Only `open` mode answers here, and that is the point of it: with one human in
   * the room there is nothing to decide, so the answer starts at the same instant
   * the server would have started it, without waiting for any words.
   */
  onUtteranceCommitted(itemId: string): boolean {
    this.stats.utterances += 1;
    if (this.mode !== 'open') return false;
    // Remembered rather than re-derived: without an id the transcript path can't
    // recognise this utterance later, and the mode can flip between the two. See
    // the guard in `onTranscript`.
    if (itemId === '') this.answeredIdlessInOpenMode = true;
    return this.answer(itemId);
  }

  /**
   * Words arrived for an utterance — either the finished transcript, or enough of
   * a partial one to be worth judging early.
   *
   * Answering twice for one utterance is the thing to avoid: a second
   * `response.create` is *queued* by the session's pending-response deferral
   * rather than dropped, so the room would hear the same reply twice.
   */
  onTranscript(itemId: string, stage: TranscriptStage = 'final'): TranscriptDecision {
    if (this.wasHandled(itemId)) return 'ignore';

    // In `open` mode an early look cannot change anything: the utterance will be
    // answered at its turn boundary whatever the verdict says, and the verdict does
    // not arrive before that boundary often enough to matter. Judging it anyway cost
    // a model call for every sentence spoken in a one-to-one call — measured on a
    // live call as a gate verdict landing 1.5s *after* the agent had already
    // started answering the same utterance.
    //
    // Only the early look is skipped. A finished transcript still reaches the
    // classifier when the utterance was not already answered, which is what covers
    // a mode flip between the boundary and the words arriving.
    if (stage === 'partial' && this.mode === 'open') return 'ignore';

    // With no id there is nothing to match the two paths on, so an utterance that
    // `open` mode already answered at the boundary cannot be recognised here, and
    // classifying it risks a second answer to the same sentence. Tested against
    // what the mode *was* when the utterance closed, not what it is now: a
    // participant leaving mid-utterance would otherwise unlatch the guard and let
    // the same sentence be answered twice.
    if (itemId === '' && this.answeredIdlessInOpenMode) {
      this.answeredIdlessInOpenMode = false;
      return 'ignore';
    }

    // Deliberately does not otherwise test the *current* mode. Someone leaving can
    // flip `addressed` → `open` in the second between an utterance closing and its
    // words arriving, and a person who used the agent's name in that second should
    // be answered rather than dropped.
    return 'classify';
  }

  /**
   * Apply the verdict on whether the agent was named.
   *
   * Re-checks the item rather than trusting the caller: verdicts arrive a few
   * hundred milliseconds late, and one judged from a partial transcript can land
   * while the finished transcript is already being judged.
   *
   * `stage` exists only for the counter. An utterance is usually judged twice —
   * once from a partial transcript, once from the finished one — and both verdicts
   * reach this method, so counting every "no" would report roughly double the
   * suppressions actually made. `suppressed` against `utterances` is the ratio that
   * says whether the gate earned its keep, and a metric at 2x is worse than no
   * metric. The finished transcript is the authoritative judgement, so it is the
   * one that counts. (The "yes" side needs no such guard: the first one to answer
   * marks the item, and the second sees it as already handled.)
   */
  resolveClassification(
    itemId: string,
    addressed: boolean,
    stage: TranscriptStage = 'final',
  ): boolean {
    if (this.wasHandled(itemId)) return false;

    if (!addressed) {
      if (stage === 'final') this.stats.suppressed += 1;
      return false;
    }

    this.stats.addressedMatches += 1;
    logger.info('[Meeting] Addressed by name — responding');
    return this.answer(itemId);
  }

  /** Record a yes: remember the item so the other path can't answer it twice. */
  private answer(itemId: string): boolean {
    this.remember(itemId);
    this.stats.answered += 1;
    return true;
  }

  private remember(itemId: string): void {
    if (!itemId) return;
    this.handledItems.push(itemId);
    if (this.handledItems.length > HANDLED_ITEM_LIMIT) this.handledItems.shift();
  }

  private wasHandled(itemId: string): boolean {
    return itemId !== '' && this.handledItems.includes(itemId);
  }
}
