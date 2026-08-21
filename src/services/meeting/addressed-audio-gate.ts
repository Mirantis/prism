/**
 * "Was that said to me?" — asked of the model that already heard it.
 *
 * The meeting session is a speech-to-speech model listening to the room. This asks
 * it, beside the conversation, to judge one utterance it has already taken in:
 * a single `YES` or `NO`, from the audio, with a prompt of its own.
 *
 * What that buys over the text gate it replaces — a transcriber, a POS tagger and
 * a separate classification model in series:
 *
 * - **Nothing is lost to transcription.** The old path could only judge what the
 *   words came back as, and names are the words a transcript gets wrong most: a
 *   live call rendered "Prism" as "Pritham" and "Hey Emma" as "Hey, I'm". A
 *   mangled name is a summons missed, and no judgement downstream recovers a word
 *   that never reached the text.
 * - **How a sentence was said is part of what it meant.** A vocative has a shape
 *   in the voice — the lift before a name, the pause after it — and a transcript
 *   keeps none of it.
 * - **The sentence stops being data we hold.** The decision no longer takes the
 *   utterance as text, so there is no prompt containing a participant's words to
 *   keep out of a log or a trace. The audio never leaves the session it arrived
 *   in: an `item_reference` points at an item the model already has.
 *
 * **A verdict sees a few turns, not one and not all of them.** Both extremes were
 * tried on live calls. Judging the utterance by itself cannot answer an unnamed
 * follow-up — "did you find anything?" carries no evidence of who it is for —
 * and the room quickly stops repeating the name. Inheriting the whole conversation
 * answered follow-ups well and then tripped the token rate limit, because every
 * Realtime response re-reads its context in full and this one runs on *every*
 * utterance rather than only on the agent's turns. `CONTEXT_WINDOW_TURNS` is the
 * middle: enough to see the exchange, bounded so the cost does not grow with the
 * call.
 *
 * No history of past *verdicts* is kept. That idea came from the text gate, where
 * it compensated for a model that could not hear which name a voice was turning
 * toward. This one can, and the turns themselves carry more than a list of yes and
 * no ever did.
 *
 * **Fails closed.** The delivery gates elsewhere fail open, because a dropped
 * alert is worse than a redundant one. Here the opposite holds: this sits in front
 * of every utterance in a group call, so a failure is systematic rather than
 * one-off, and answering a whole room is exactly what this exists to prevent.
 * The cost is real and worth stating: while the probe is failing the agent is
 * entirely mute in a group call. Silence is recoverable by repeating yourself; a
 * room-wide interruption is not.
 */

import { logger } from '../../logger';
import type { OutOfBandRequest } from './realtime-session';
import { formatGateReasoning, formatRoster } from './transcript-log';

/**
 * How long a verdict stays worth acting on.
 *
 * Past this the room has moved on, and answering a question everyone has stopped
 * caring about is its own kind of wrong — worse in a meeting than simply having
 * missed it.
 *
 * Inherited from the text gate, which set it well clear of an observed 0.9–1.5s
 * with a tail past 2.5s rather than snugly around it, because dropping a *yes*
 * means ignoring someone who called the agent by name. Whether this model is
 * faster or slower than that is not yet measured, so the generous bound stays
 * until it is.
 */
export const ADDRESSED_DEADLINE_MS = 6_000;

/**
 * How many output tokens a one-word verdict is allowed.
 *
 * A cap, not a target: the answer measured five tokens. Sixty-four rather than
 * sixteen because it costs nothing when unused and the failure it guards against is
 * total — a response that runs out of budget comes back `incomplete` with *empty*
 * output, and an empty answer is a failure, which for this gate means silence.
 */
const VERDICT_TOKEN_BUDGET = 64;

/**
 * How hard to think about a one-word question: as little as the API documents.
 *
 * Set explicitly because the session runs at `high` for the sake of the agent's own
 * turns, and a probe inherits that unless told otherwise. Measured against a live
 * session on the same utterance, inheriting `high` spent 36 reasoning tokens and
 * 1401ms for a verdict that needed five tokens — and at a tight output budget it
 * never reached the word at all, returning `incomplete` with empty output, which
 * this gate reads as a failure and answers with silence.
 *
 * `low` rather than anything lower: it is a documented level for this API (the same
 * set `OPENAI_REALTIME_REASONING_EFFORT` accepts). An undocumented value may be
 * tolerated today and quietly re-interpreted tomorrow, and a level that stops being
 * applied would put this back to inheriting `high`.
 */
const VERDICT_REASONING_EFFORT = 'low';

/**
 * How many spoken turns of the call a verdict may look back over.
 *
 * The judged utterance plus the five before it. Both extremes were tried live and
 * both failed: judging the utterance alone cannot answer an unnamed follow-up,
 * because "did you find anything?" carries no evidence of who it is for, while
 * inheriting the whole conversation answered them well and then tripped the token
 * rate limit — 21,382 tokens for one response against a 40,000-per-minute ceiling,
 * which is under two responses a minute where a busy room produces ten to twenty
 * utterances.
 *
 * Six because the follow-ups seen failing needed two or three turns of context —
 * the question, the agent's answer, the follow-up — and this leaves room either
 * side without the cost growing for the length of the call. Tool output never
 * enters the window at all (see `recentConversationItems`), which measurement
 * suggests matters more than the count: one 12,000-character tool result came to
 * ~2,900 tokens, more than the entire spoken conversation around it.
 */
const CONTEXT_WINDOW_TURNS = 6;

export interface AddressedGatePromptInput {
  /** What the room hears the agent called — the name it introduced itself by. */
  agentName: string;
  /** Everyone else the room currently holds, agent excluded. */
  roster: string[];
}

/**
 * The whole context for a verdict, beside the call itself.
 *
 * Naming the other people in the room is what separates "Prism, ask Emma about
 * the cluster" from "Emma, ask Prism about the cluster" — two sentences with the
 * same words in them, one of which is not the agent's to answer. Without a roster
 * the model has only word order to go on.
 *
 * The prompt asks about the *most recent* utterance rather than a named one,
 * because the probe carries no `input` array and so inherits the session's own
 * conversation — see `judgeAddressed`. That is what makes the follow-up rule below
 * answerable rather than a guess: the model can see whether the agent was already
 * in an exchange, instead of being asked to assume one from a bare question.
 */
export function buildAddressedGatePrompt(input: AddressedGatePromptInput): string {
  const { agentName, roster } = input;
  const others =
    roster.length > 0
      ? `Other people in the call: ${roster.join(', ')}.`
      : 'You do not know who else is in the call.';

  return `You are in a live meeting as ${agentName}, taking part by voice as one
participant among several. ${others}

You can see the call so far. Judge **only the most recent thing somebody said** — the
latest utterance, not anything before it. Was that one spoken to ${agentName}?

Answer with exactly one word: YES or NO.

Answer YES when it is addressed to ${agentName}:

- The name used to speak *to* it, together with something meant for it. Accept a name
  mispronounced or half-swallowed, since people say names quickly.
- Or a direct question, answer or instruction that plainly continues an exchange
  ${agentName} is already in — the next question after ${agentName} has just spoken,
  someone asking whether it found something it was just asked to look for, or a
  correction to what it said. A follow-up does not have to repeat the name.

Answer NO otherwise, which in a meeting is most of what is said:

- People talking to each other, including right after ${agentName} has spoken. Being
  next in line is not the same as continuing its exchange, and a request can sound
  exactly like one meant for an assistant while being one colleague asking another.
- ${agentName} talked *about* rather than to — "I asked it yesterday", "maybe
  ${agentName} could look at that" — or the name raised as a topic or an agenda item.
- Somebody else addressed by name, **including when the sentence also mentions
  ${agentName}**. "Emma, could you ask ${agentName} about the cluster?" is spoken to
  Emma, and the answer is NO.
- A new subject nobody has involved ${agentName} in.
- A word that merely sounds like ${agentName} without being it.

If you are not sure, answer NO.`;
}

/**
 * Pull YES or NO out of whatever the model actually wrote.
 *
 * It is asked for one word and mostly obliges, but the text gate saw "NO\n\nThis
 * is a" — an explanation the token budget cut off mid-sentence. Reading only the
 * first characters would then hinge on which word happened to come first, so the
 * first standalone YES/NO token decides instead.
 */
function readVerdict(text: string): boolean {
  return text.toUpperCase().match(/\b(YES|NO)\b/)?.[1] === 'YES';
}

/**
 * The context list for one verdict: recent turns, judged utterance last.
 *
 * The judged item is normally already the newest tracked turn, so it is pulled out
 * and re-appended rather than assumed to be in position — a duplicate reference, or
 * a judged item sitting mid-list, would each undermine "judge the last one".
 */
function windowFor(session: OutOfBandAsk, judgedItemId: string): unknown[] {
  const recent = session.recentConversationItems(CONTEXT_WINDOW_TURNS);
  const ordered = judgedItemId
    ? [...recent.filter((id) => id !== judgedItemId), judgedItemId]
    : recent;
  return ordered.map((id) => ({ type: 'item_reference', id }));
}

/**
 * Just the part of the session this needs, so a test needs no socket.
 *
 * The request type is the session's own rather than a copy of it: a copy would let
 * the two drift, and the fields here are exactly the ones whose values were
 * measured against a live session.
 */
export interface OutOfBandAsk {
  requestOutOfBandText(request: OutOfBandRequest): Promise<string | null>;
  /** The most recent spoken turns, oldest first, tool output excluded. */
  recentConversationItems(limit: number): string[];
}

export interface JudgeAddressedInput extends AddressedGatePromptInput {
  /** The committed utterance to judge, as the session named it. */
  itemId: string;
}

export interface AddressedVerdict {
  /** Whether to answer. False whenever there is any doubt, including failure. */
  addressed: boolean;
  /**
   * True when there was no verdict to be had, as opposed to a verdict of no.
   *
   * Both keep the agent quiet, so nothing downstream branches on it — but they are
   * different problems with different fixes, and only a count of these says the
   * agent was deaf rather than merely unaddressed.
   */
  failed: boolean;
  elapsedMs: number;
}

/**
 * Judge one utterance. Never throws.
 *
 * The verdict is logged here because the elapsed time is the point of logging it
 * at all in production: it sits between somebody finishing a sentence and the
 * agent starting to answer, so it is the one number that says whether the room is
 * being kept waiting.
 */
export async function judgeAddressed(
  session: OutOfBandAsk,
  input: JudgeAddressedInput,
): Promise<AddressedVerdict> {
  const started = Date.now();

  const answer = await session.requestOutOfBandText({
    instructions: buildAddressedGatePrompt(input),
    // A bounded slice of the call, ending on the utterance being judged.
    //
    // Both halves matter. The recent turns are what make an unnamed follow-up
    // answerable — "did you find anything?" means nothing on its own, and everything
    // after the agent has just been asked to look something up. Ending on the judged
    // item is what keeps a verdict attached to the right sentence: the prompt tells
    // the model to judge the last one, so two turns closing while a verdict is in
    // flight can no longer swap them.
    input: windowFor(session, input.itemId),
    metadata: { purpose: 'addressed-gate', item: input.itemId || 'none' },
    deadlineMs: ADDRESSED_DEADLINE_MS,
    maxOutputTokens: VERDICT_TOKEN_BUDGET,
    reasoningEffort: VERDICT_REASONING_EFFORT,
  });

  const elapsedMs = Date.now() - started;

  if (answer === null) {
    // Already logged in detail by whatever gave up — a rejection, a deadline or a
    // shut socket. This line is the one that ties it to an utterance.
    logger.warn(
      `[Meeting:Gate] No verdict for item=${input.itemId || 'none'} after ${elapsedMs}ms ` +
        '— staying quiet',
    );
    return { addressed: false, failed: true, elapsedMs };
  }

  const addressed = readVerdict(answer);
  const reasoning = formatGateReasoning(answer);
  logger.info(
    [
      `[Meeting:Gate] verdict addressed=${addressed}`,
      `item=${input.itemId}`,
      `${elapsedMs}ms`,
      formatRoster(input.roster),
      reasoning === '' ? '' : `said=${JSON.stringify(reasoning)}`,
    ]
      .filter(Boolean)
      .join(' '),
  );

  return { addressed, failed: false, elapsedMs };
}
