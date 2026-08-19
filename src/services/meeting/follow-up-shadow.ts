/**
 * Was that follow-up really a follow-up? Asked after the fact, off the latency path.
 *
 * The window's precision has to be measured somehow, and that needs ground truth it cannot
 * supply — it would
 * be marking its own homework. So an accepted follow-up is answered immediately, at 0ms,
 * and *then* a cheap model call is made in the background and disagreements are counted.
 * The room never waits for it and the answer never changes; this measures the error rate
 * without paying for it in silence.
 *
 * **Why not shadow the addressed gate.** The obvious version of this — run
 * `classifyAddressed` alongside and count where the two differ — measures nothing at all.
 * That gate answers one question: was the assistant called *by name*. A follow-up has no
 * name in it by construction, which is the entire reason the window exists, so the gate
 * would say no to essentially every accepted follow-up and the "disagreement rate" would
 * sit near 100% whether the window was right or wrong.
 *
 * So this asks the question the window is actually making a claim about: given that the
 * assistant has just answered this person, is what they said next still aimed at it?
 *
 * **Fails silent, not open or closed.** A failed call is recorded as no judgement rather
 * than as agreement or disagreement — a metric that quietly counts outages as successes is
 * worse than a gap in the metric.
 */

import { generateText } from 'ai';
import { config } from '../../config';
import { getGateRequest } from '../../lib/classification';
import { langfuseTelemetry } from '../../lib/telemetry';
import { logger } from '../../logger';

/**
 * Free of any particular name, for the reason `addressed-classifier.ts` gives: the agent's
 * name is arbitrary user-set text, so it arrives as data rather than baked into a prompt
 * where a name chosen to read as an instruction would have weight.
 */
const SYSTEM = `
An assistant has just spoken in a live meeting, answering a question from one person.
That same person then said the sentence below.

Is the sentence still part of that exchange — a follow-up aimed at the assistant?

Answer with one word: CONTINUE or MOVED_ON.

CONTINUE if it reads as more of the same conversation with the assistant: another
question, a refinement, a correction, a request to go further.

MOVED_ON if the speaker has turned to somebody else, addressed the room, changed the
subject, or simply made a remark that expects no answer. If unsure, MOVED_ON.
`.trim();

/** What the shadow judge thought, or null when it could not be asked. */
export type FollowUpJudgement = 'continue' | 'moved_on' | null;

/**
 * Take the first standalone verdict token out of whatever the model wrote.
 *
 * Same shape as the addressed gate's reader and for the same reason: asked for one word,
 * the model sometimes writes a sentence and the token budget cuts it off mid-explanation.
 */
function readVerdict(text: string): FollowUpJudgement {
  const match = text.toUpperCase().match(/\b(CONTINUE|MOVED_ON|MOVED ON)\b/);
  if (match === undefined || match === null) return null;
  return match[1] === 'CONTINUE' ? 'continue' : 'moved_on';
}

export interface JudgeFollowUpInput {
  transcript: string;
  agentName: string;
}

/** Judge an already-answered follow-up. Never throws; never blocks anything. */
export async function judgeFollowUp(input: JudgeFollowUpInput): Promise<FollowUpJudgement> {
  try {
    const { model, providerOptions, minOutputTokens = 0, samplingParams } = getGateRequest();
    const result = await generateText({
      model,
      providerOptions,
      system: SYSTEM,
      messages: [
        {
          role: 'user' as const,
          content: `Assistant's name: ${input.agentName}\nSentence: ${input.transcript}`,
        },
      ],
      // Enough for "MOVED_ON" plus a word of overrun. Latency is irrelevant here — nothing
      // waits for this — but tokens are not, and a judge that writes a paragraph per
      // follow-up would make the measurement cost more than the feature saves.
      maxOutputTokens: Math.max(8, minOutputTokens),
      ...samplingParams,
      // The prompt *is* the sentence somebody said, so it follows the same switch as every
      // other line a call produces. Otherwise turning the transcript out of the log would
      // send it to a trace store on another host instead.
      ...langfuseTelemetry('meeting-follow-up-shadow', undefined, {
        recordContent: config.meetingTranscriptLogging === 'full',
      }),
    });
    return readVerdict(result.text);
  } catch (error) {
    // No judgement, deliberately. Counting an outage as agreement would make the metric
    // look best exactly when it is least trustworthy.
    logger.debug(`[Meeting:FollowUp] Could not judge a follow-up after the fact: ${String(error)}`);
    return null;
  }
}
