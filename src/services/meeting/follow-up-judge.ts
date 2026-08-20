/**
 * Whether an utterance inside an open exchange is aimed at the agent.
 *
 * This replaced a set of hand-written rules — question openers, request phrases, hortatives,
 * invitations, group vocatives and a word threshold — that decided the same thing from the
 * sentence alone. Every one of them was added from a single sentence somebody said in a call,
 * and each one exposed the next: a request whose question sat in the first of three sentences,
 * an acknowledgement read as somebody's name, a speaker handing the floor back with "go ahead",
 * a five-word hortative that slipped under a length bound.
 *
 * The rules could not be finished, because the sentence does not carry the answer. "So what
 * happens for an end user at 14 days?" is a follow-up if it was said to the agent and an
 * interruption if it was said to a colleague, and the words are identical. What separates them
 * is who has been talking to whom, and that lives in the transcript rather than in the
 * sentence. So the transcript is what this call gets.
 *
 * Measured on three real meeting transcripts, 1389 utterances from meetings no agent attended,
 * so every acceptance is a wrong answer:
 *
 *     the hand-written rules                     10.9% accepted
 *     this question, no context                  59.3%
 *     this question, six lines of context        38.0%
 *     this question, context and the pushback    6.7%
 *
 * The pushback paragraph is the part that carries most of that: it says outright that most
 * meeting speech is between the people. 6.7% against the rules' 10.9% is why the rules are
 * gone.
 *
 * Recall is the half this corpus cannot measure — those meetings contain no agent, so they
 * hold no genuine follow-ups. Against utterances labelled by hand from our own calls this
 * scored 6 of 7 where the rules scored 5, so it is not worse on the evidence available, and
 * that evidence is seven sentences. `meeting ended` reports the accept and decline counts, so
 * real calls keep measuring it.
 *
 * Costs about 600ms. A declined utterance produces no speech, so that time is inaudible; only
 * an accepted follow-up is paid for out loud, and it replaces a rule set that answered at 0ms
 * and was wrong more often.
 *
 * Fails **closed**, like the addressed gate: a failed call declines, and the utterance carries
 * on to the addressed gate exactly as it would have.
 */

import { generateText } from 'ai';
import { config } from '../../config';
import { getGateRequest } from '../../lib/classification';
import { langfuseTelemetry } from '../../lib/telemetry';
import { logger } from '../../logger';
import { formatTranscript } from './transcript-log';

/**
 * How much of the meeting to show it.
 *
 * Six lines took acceptance of ordinary meeting speech from 59.3% to 38.0%, and fourteen
 * lines to 32.0% — so the return falls away quickly while the prompt keeps growing. Six lines
 * plus the pushback paragraph reached 6.7%, which is where the wording earns more than the
 * length does.
 */
export const CONTEXT_LINES = 6;

/**
 * The agent is named in the question and labels its own lines in the transcript, so the model
 * can tie "Iris: (answered)" to the sentence that followed it. Measured this way; a generic
 * "the assistant" was not.
 */
function systemPrompt(agentName: string, roster: readonly string[]): string {
  const others =
    roster.length > 0
      ? ` Also in the call: ${roster.join(', ')} — any of them may be a person or another AI` +
        ' assistant.'
      : '';
  return `
You are reading the tail of a live meeting transcript. An AI assistant called ${agentName} is
in the call.${others} The last line is what somebody has just said.

Is that last line aimed at ${agentName}, so that ${agentName} should answer it?

Answer with one word: CONTINUE or MOVED_ON.

CONTINUE if the last line needs ${agentName} to answer: a question to ${agentName}, a follow-up
to something ${agentName} said, or a request for ${agentName} to do something.

MOVED_ON if it is aimed at somebody else in the call, continues a discussion between the
others, expects no answer, or changes the subject. Use the earlier lines to see who has been
talking to whom. If unsure, MOVED_ON.

Naming somebody else is decisive. If the last line names anybody but ${agentName}, it belongs
to them — even in passing, even when it is a question, and even when it comes straight after
${agentName} has spoken.

Most of what is said in a meeting is said between the people, not to ${agentName}. A sentence
shaped like a question is not enough: colleagues ask each other questions constantly. If the
last line would make sense said to a colleague, answer MOVED_ON.
`.trim();
}

/** One line of the transcript as the judge reads it. */
export interface JudgeLine {
  /** Who spoke. The agent's own turns carry its name. */
  speaker: string;
  text: string;
}

export interface JudgeFollowUpInput {
  /** What the room calls the agent. Named in the prompt and labelling its own lines. */
  agentName: string;
  /**
   * Everybody else in the call, so a sentence naming one of them is theirs.
   *
   * Measured on 120 utterances of real meeting speech: wrong accepts fell from 7 to 3 with
   * the names in hand. The transcript alone is not enough — a speaker label says who *spoke*,
   * never who was spoken to, and an exchange with the agent is exactly where a question for
   * a colleague looks most like a continuation.
   */
  roster?: readonly string[];
  /** Recent lines, oldest first, with the utterance under judgement last. */
  lines: readonly JudgeLine[];
  /**
   * The utterance being judged, for the log line.
   *
   * A `CONTINUE` is answered, so it never reaches the addressed gate and the gate's line
   * is where every other sentence in a call gets written down. Without the id here, the
   * utterances the agent chose to answer were the only ones missing from the log — which
   * is the population most worth reading back.
   */
  itemId: string;
}

/** True when the agent should answer. False on a decline **and** on a failed call. */
export async function judgeFollowUp(input: JudgeFollowUpInput): Promise<boolean> {
  if (input.lines.length === 0) return false;
  const started = Date.now();
  try {
    const { model, providerOptions, minOutputTokens = 0, samplingParams } = getGateRequest();
    const result = await generateText({
      model,
      providerOptions,
      system: systemPrompt(input.agentName, input.roster ?? []),
      messages: [
        {
          role: 'user' as const,
          content: input.lines.map((line) => `${line.speaker}: ${line.text}`).join('\n'),
        },
      ],
      // One word, and the parser takes the first standalone verdict wherever it lands.
      // Same reasoning as the addressed gate, one step looser: this prompt invites a
      // sentence more than that one does, and the provider's floor wins where a tighter
      // cap is illegal.
      maxOutputTokens: Math.max(16, minOutputTokens),
      ...samplingParams,
      // The prompt on this call is several sentences the room said, so it follows the same
      // switch as every log line that carries speech. A trace store is a durable record on
      // another host, which is the weaker of the two outcomes.
      ...langfuseTelemetry('meeting-follow-up-judge', undefined, {
        recordContent: config.meetingTranscriptLogging === 'full',
      }),
    });
    const answer = /\bCONTINUE\b/i.test(result.text);
    // The whole context, not just the sentence: the judgement is about how the utterance
    // sits against what was said before it, so a verdict cannot be argued with from the
    // sentence alone. Behind the same switch as every other line that carries speech.
    const context = formatTranscript(
      input.lines.map((line) => `${line.speaker}: ${line.text}`).join(' | '),
    );
    logger.info(
      [
        `[Meeting:FollowUp] judge says ${answer ? 'CONTINUE' : 'MOVED_ON'}`,
        `item=${input.itemId || 'none'}`,
        `(${input.lines.length} lines, ${Date.now() - started}ms)`,
        context,
      ]
        .filter(Boolean)
        .join(' '),
    );
    return answer;
  } catch (error) {
    // Closed. The utterance still reaches the addressed gate, so a failure costs a
    // follow-up its shortcut rather than costing the speaker an answer.
    logger.error({ err: error }, '[Meeting:FollowUp] Judge failed, declining');
    return false;
  }
}
