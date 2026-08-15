/**
 * "Did someone just call my name?" — asked of a model, not of a regex.
 *
 * The question is deliberately narrow. It is **not** "does this sentence sound
 * like a request for an assistant": a mixed mono stream carries no speaker
 * labels, so "can you add apples to the list?" is identical whether it was said
 * to the agent or to the person in the next chair, and a gate that guesses at
 * that will interrupt real conversations. Being named is the one signal a room
 * actually gives, so that is the only thing judged here.
 *
 * What a model buys over the string match this replaces:
 *
 * - **Transcription mangles names.** A live call rendered "Prism" as "Pritham".
 *   An exact match misses that; a model reading the sentence does not. The name
 *   is also arbitrary user-set text, so there is no fixed vocabulary to prepare
 *   for — matching it means guessing how a speech model will spell a word nobody
 *   has seen before.
 * - **A name can be mentioned without being addressed.** "I asked Prism about
 *   that earlier" contains the name and is plainly not talking to it. A regex
 *   answers yes. Being wrong in that direction is what makes the agent butt in.
 *
 * **Fails closed.** The delivery gates elsewhere fail open, because a dropped
 * alert is worse than a redundant one. Here the opposite holds: this sits in
 * front of every utterance in a group call, so an outage is systematic rather than
 * one-off, and answering everything is exactly the bug this path exists to prevent.
 * Be aware of what that costs: while the classification model is unavailable the
 * agent is entirely mute in a group call, since there is no other way to reach it.
 * That is still the better failure — silence is recoverable by repeating yourself,
 * and a room-wide interruption is not — but it is a real outage, not a graceful
 * degradation.
 */

import { generateText } from 'ai';
import { getGateRequest } from '../../lib/classification';
import { langfuseTelemetry } from '../../lib/telemetry';
import { logger } from '../../logger';

/**
 * How long a verdict stays worth acting on.
 *
 * Past this the room has moved on, and answering a question everyone has stopped
 * caring about is its own kind of wrong — worse in a meeting than simply having
 * missed it.
 *
 * Six seconds rather than the three this started at, because the first estimate
 * was wrong by a lot. Live calls put the gate at 0.9–1.5s with a tail past 2.5s —
 * a transatlantic round trip to the classification model, not token cost — which
 * left one slow request between a spoken name and a dropped verdict. Dropping a
 * *yes* means ignoring someone who called the agent by name, the worst failure this
 * feature has, so the bound is set well clear of the observed tail rather than
 * snugly around it.
 */
export const CLASSIFY_DEADLINE_MS = 6_000;

/**
 * Deliberately free of any particular name.
 *
 * The agent's name is arbitrary and can be changed at any time, so an example
 * written around one real name would be wrong for every other agent and stale for
 * this one the moment it is renamed. The name arrives as data in the user message
 * instead — which also keeps user-settable text out of the system prompt, where a
 * name chosen to read as an instruction would carry more weight.
 *
 * Exported only so the log-redaction test can assert on the real text: this prompt
 * travels on a failed request as `requestBodyValues`, alongside the sentence someone
 * said, and a test that used a stand-in string would prove nothing about this one.
 */
export const SYSTEM = `
You are given an AI assistant's name and one sentence transcribed from a live
meeting. Did the speaker call that assistant by name?

Answer with one word: YES or NO.

YES only if the name is used to address it — spoken *to* the assistant, alongside
something meant for it. Accept a clear mishearing, since transcription is imperfect:
a word that sounds like the name, is spelled close to it, or is split or merged with
a neighbour.

NO if the name is absent, however much the sentence sounds like a request; if the
name is what the speaker is talking *about* rather than who they are talking *to* —
the name with "the" in front of it, or raised as a topic or an agenda item, is a
subject rather than someone being addressed; if the assistant is referred to in the
third person ("I asked it yesterday", "it could help with that"); or if a word merely
resembles the name. If unsure, NO.
`.trim();

/**
 * Pull YES or NO out of whatever the model actually wrote.
 *
 * It is asked for one word and mostly obliges, but a live call produced
 * "NO\n\nThis is a" — an explanation the token budget cut off mid-sentence.
 * Reading only the first characters would then hinge on which word happened to
 * come first, so the first standalone YES/NO token decides instead. Anything
 * else is treated as "not addressed", the same direction as a failure.
 */
function readVerdict(text: string): boolean {
  const match = text.toUpperCase().match(/\b(YES|NO)\b/);
  return match?.[1] === 'YES';
}

export interface ClassifyAddressedInput {
  transcript: string;
  /** What the room hears the agent called — the name it introduced itself by. */
  agentName: string;
  /**
   * Whether this is judged from a partial transcript or the finished one.
   *
   * Logged rather than used: it is the only way to tell from outside whether the
   * transcriber streams at all, and so whether the early path — the one that hides
   * this call's latency behind the rest of the sentence — is doing anything.
   */
  stage: 'partial' | 'final';
}

/** True when the speaker called the agent by name. Never throws. */
export async function classifyAddressed(input: ClassifyAddressedInput): Promise<boolean> {
  const started = Date.now();
  try {
    const { model, providerOptions, minOutputTokens = 0, samplingParams } = getGateRequest();
    const result = await generateText({
      model,
      providerOptions,
      system: SYSTEM,
      messages: [
        {
          role: 'user' as const,
          content:
            `Assistant's name: ${input.agentName}\n` +
            `Sentence: ${input.transcript}`,
        },
      ],
      // Deliberately tight. Asked for one word the model writes a sentence anyway,
      // and every token of it is latency on the one path whose whole purpose is
      // speed: raising this to 32 to guard against a truncated verdict cost a
      // measured ~700ms per call against a risk that never materialised across a
      // meeting's worth of live traffic — the verdict always came first, and the
      // parser takes the first standalone YES/NO wherever it lands. Eight leaves
      // room for "NO The speaker did" and stops short of funding an explanation —
      // on vendors that allow it: the provider's floor wins where a tighter cap
      // is illegal (OpenAI's Responses API rejects anything under 16).
      maxOutputTokens: Math.max(8, minOutputTokens),
      ...samplingParams,
      ...langfuseTelemetry('meeting-addressed-gate'),
    });

    const addressed = readVerdict(result.text);
    // The elapsed time is the point of logging this at all in production: it sits
    // between someone finishing a sentence and the agent starting to answer, so it
    // is the one number that says whether the room is being kept waiting.
    logger.info(
      `[Meeting:Gate] ${result.text.trim().replace(/\s+/g, ' ')} ` +
        `(addressed=${addressed}, ${input.stage}, ${Date.now() - started}ms)`,
    );
    return addressed;
  } catch (error) {
    // Closed, not open — see the module comment.
    logger.error({ err: error }, '[Meeting:Gate] Call failed, staying quiet');
    return false;
  }
}
