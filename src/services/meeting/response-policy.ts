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
 *   It answers on end-of-utterance, which is the same instant the server would
 *   have created the response itself, so a one-to-one call is no slower than it
 *   was with the API driving.
 * - **addressed** — more than one human, so most of what is said is not for the
 *   agent. Which utterances are is decided by `addressed-audio-gate.ts`, which asks
 *   the meeting model about the one it just heard. Not by matching a string: an
 *   agent can be called anything, and a name can be mentioned without being
 *   addressed ("I asked Prism about that yesterday").
 *
 * Deliberately *not* judged: whether a sentence merely sounds like a request for
 * an assistant. The room is one mixed channel with no speaker labels, so "can you
 * add apples to the list?" is identical whether it was said to the agent or to the
 * person in the next chair. Guessing there is how a meeting bot ends up in the
 * middle of other people's conversations.
 *
 * **No clock decides a follow-up.** An earlier version kept a 15-second window in
 * which any utterance counted as addressed, so a follow-up needn't repeat the name.
 * Real calls killed it: fifteen seconds after the agent stops talking is mostly
 * other people starting to talk to *each other*, and a window cannot tell those
 * apart from a genuine follow-up. Nothing here replaced it — an unnamed follow-up
 * is answered, but because the gate can *see* the exchange it belongs to, which is
 * a judgement rather than a grace period. This object holds no timers.
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
 * What to do with an utterance the turn detector has just closed.
 *
 * `gate` means this object declines to decide: whether the agent was addressed is
 * a judgement made from the audio by a model, and judgements cannot live in a
 * class the rest of the code calls synchronously.
 */
export type TurnDecision = 'respond' | 'gate' | 'ignore';

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

  /**
   * Take a participant-count reading (including the agent itself).
   *
   * `null` means the UI could not be read, which is never a reason to change
   * behaviour — the last known mode stands. Ignored entirely unless the caller
   * asked for `auto`.
   */
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
   * The turn detector closed an utterance — the one moment a turn is decided.
   *
   * `respond` in a one-to-one call, where there is nothing to decide: the answer
   * starts at the same instant the server would have started it. `gate` otherwise,
   * meaning "ask the model whether this was aimed at us". `ignore` for an utterance
   * already handled, which is what stops one sentence being answered twice — a
   * second `response.create` is *queued* by the session's pending-response
   * deferral rather than dropped, so the room would hear the same reply twice.
   */
  onUtteranceCommitted(itemId: string): TurnDecision {
    // Counted *after* the duplicate check, so a commit the room only made once is
    // not tallied twice. Otherwise `utterances` drifts above what was said and the
    // suppressed-against-utterances ratio the stats exist for slowly stops meaning
    // anything.
    if (this.wasHandled(itemId)) return 'ignore';
    this.stats.utterances += 1;
    if (this.mode !== 'open') return 'gate';
    this.answer(itemId);
    return 'respond';
  }

  /**
   * Apply the verdict on whether the agent was addressed.
   *
   * Re-checks the item rather than trusting the caller: a verdict arrives a few
   * hundred milliseconds after the utterance closed, and the room does not wait.
   * By then the mode may have flipped, or — for an id-less utterance — something
   * else may already have answered it.
   */
  resolveVerdict(itemId: string, addressed: boolean): boolean {
    if (this.wasHandled(itemId)) return false;

    if (!addressed) {
      this.stats.suppressed += 1;
      return false;
    }

    this.stats.addressedMatches += 1;
    logger.info('[Meeting] Addressed — responding');
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
