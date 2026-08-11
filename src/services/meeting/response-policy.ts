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
 * - **addressed** — more than one human, so an utterance has to look like it was
 *   aimed at the agent: its name (or an alias), or the sticky window below.
 *   This is the one path that waits for the transcript.
 *
 * **Sticky engagement.** Requiring the name on every turn makes a real
 * back-and-forth stilted ("Prism, and staging?" … "Prism, thanks"). So for a
 * short while after the agent finishes speaking, the next utterance counts as
 * addressed. Two things keep that from re-creating the original problem: the
 * window is anchored to the *agent's* last turn rather than the last thing any
 * human said, and it survives only a few consecutive unaddressed turns before
 * the name is needed again. Both are deliberate — there is no reliable
 * "that wasn't for me" classifier, which is the whole premise here, so the
 * escape hatch has to be a timer and a counter rather than a judgement.
 *
 * Every "yes" from this object *will* be spoken: unlike prompt-level gating there
 * is no path for the model to decline once `response.create` goes out. That makes
 * false positives the failure mode to design against, hence the conservative
 * window and the counter.
 */

import { logger } from '../../logger';
import { isAddressedToAgent } from './addressed-detection';

/** What the caller asked for. `auto` resolves from the participant count. */
export type ResponseMode = 'auto' | 'open' | 'addressed';

/** What the policy is actually doing right now. */
export type EffectiveMode = 'open' | 'addressed';

/**
 * How long after the agent stops speaking an unnamed utterance still counts.
 *
 * Long enough for someone to react to what they just heard, short enough that
 * two humans resuming their own conversation get at most one stray answer.
 */
export const STICKY_WINDOW_MS = 15_000;

/**
 * Consecutive unnamed answers the sticky window will carry before the agent's
 * name is needed again.
 *
 * Without a cap, a room that keeps talking keeps renewing the window and the
 * agent is back to answering everything — the bug this file exists to fix. Three
 * covers the usual "check X" / "and staging?" / "what about prod?" run.
 */
export const MAX_STICKY_TURNS = 3;

/** Item ids remembered for the duplicate check. Bounded; turns are short-lived. */
const HANDLED_ITEM_LIMIT = 32;

export interface ResponsePolicyOptions {
  mode: ResponseMode;
  /** The name the agent answers to — the workspace name the room hears. */
  agentName: string;
  /** Extra spellings, for names live transcription reliably mangles. */
  aliases?: string[];
}

export interface ResponsePolicyStats {
  /** Utterances the room produced (committed by the turn detector). */
  utterances: number;
  /** Of those, the ones the agent answered. */
  answered: number;
  /** Of those, the ones it stayed quiet through. */
  suppressed: number;
  /** Answers that came from a name/alias match rather than the sticky window. */
  addressedMatches: number;
  /** How often the effective mode changed as people joined or left. */
  modeSwitches: number;
}

export class ResponsePolicy {
  /**
   * Starts `addressed` rather than `open` when nothing is known yet.
   *
   * A count arrives moments after admission, so this covers a scraper that can't
   * read the UI at all. Guessing `open` there would put the original bug back in
   * a full room; guessing `addressed` costs a one-to-one caller one spoken name,
   * after which the sticky window carries the conversation.
   */
  private mode: EffectiveMode = 'addressed';
  /** When the sticky window lapses. 0 = closed. */
  private engagedUntil = 0;
  /** Consecutive answers so far owed to the sticky window rather than a name. */
  private stickyTurns = 0;
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
  setParticipantCount(count: number | null): void {
    if (count === null || this.options.mode !== 'auto') return;

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
   * The turn detector closed an utterance.
   *
   * The decision point for `open` mode and for an already-engaged room, both of
   * which can answer without knowing what was said. In `addressed` mode with the
   * window shut this only counts the utterance; `onTranscript` decides.
   */
  onUtteranceCommitted(itemId: string): boolean {
    this.stats.utterances += 1;

    if (this.mode === 'open') return this.answer(itemId);

    // Answering here and again on the transcript would be spoken twice, not
    // deduplicated — and an utterance with no id can't be matched between the two
    // paths. Rather than risk that, leave it to the transcript, which is the only
    // path that can also tell whether it was addressed. Costs a little latency in
    // a case the API is not expected to produce at all.
    if (this.isEngaged() && itemId !== '') {
      this.stickyTurns += 1;
      logger.info('[Meeting] Following up on my own turn — responding');
      return this.answer(itemId);
    }

    return false;
  }

  /**
   * A finished utterance's transcript arrived.
   *
   * The words are read even for an utterance already answered at commit time,
   * because a mention refills the sticky budget whether or not it was needed to
   * decide — a fully named back-and-forth should never run out of turns. What is
   * not repeated is the answer: a second `response.create` for one utterance is
   * *queued* by the session's pending-response deferral rather than dropped, so
   * the room would hear the same reply twice.
   */
  onTranscript(itemId: string, transcript: string): boolean {
    const addressed = isAddressedToAgent(
      transcript,
      this.options.agentName,
      this.options.aliases,
    );

    if (addressed) {
      // An explicit mention is a fresh start: the sticky budget measures how far a
      // conversation coasts *without* one.
      this.stickyTurns = 0;
      if (this.wasHandled(itemId)) return false;
      this.stats.addressedMatches += 1;
      logger.info('[Meeting] Addressed directly — responding');
      return this.answer(itemId);
    }

    if (this.wasHandled(itemId)) return false;
    // Open mode already answered at the turn boundary; nothing was held back.
    if (this.mode === 'open') return false;

    this.stats.suppressed += 1;
    return false;
  }

  /**
   * Someone talked over the agent and took the floor.
   *
   * Opens the follow-up window, because someone who cuts the agent off is usually
   * reacting to it and shouldn't have to say its name to be heard. It does *not*
   * refill the sticky budget, and that distinction is the whole point: barge-in
   * fires on any human speech that overlaps the agent for half a second, which in
   * a busy room is indistinguishable from two people simply carrying on their own
   * conversation while it talks. Refilling here would let that cross-talk renew
   * its own licence every time it overlapped an answer, and the budget — the one
   * thing stopping the agent drifting back to answering the whole room — would
   * never bind.
   */
  onInterrupted(): void {
    this.engage();
  }

  /** The agent finished speaking — open the follow-up window. */
  onAgentTurnEnded(): void {
    this.engage();
  }

  /** Record a yes: remember the item so the other path can't answer it twice. */
  private answer(itemId: string): boolean {
    this.remember(itemId);
    this.stats.answered += 1;
    return true;
  }

  private engage(): void {
    this.engagedUntil = Date.now() + STICKY_WINDOW_MS;
  }

  /**
   * Open window *and* budget left. The counter is what stops a room that keeps
   * talking from renewing its way back to answering everything; only a name
   * (or an interruption) refills it.
   */
  private isEngaged(): boolean {
    return this.engagedUntil > Date.now() && this.stickyTurns < MAX_STICKY_TURNS;
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
