/**
 * What a meeting's words are allowed to look like in a log line.
 *
 * A call's utterances used to be logged verbatim, at `info`, next to the roster of
 * everyone in the room — a diagnostic that was genuinely useful and quietly turned the
 * deployment's log into a transcript of a conversation nobody in the room consented to.
 * These formatters are the only place that decides whether any of it is written, and
 * `MEETING_TRANSCRIPT_LOGGING` is what chooses (see config.ts for why the default is
 * `off`, and why it is a variable of its own rather than a log level).
 *
 *     off   [Meeting:Gate] verdict addressed=false item=item-4 641ms roster=2
 *     full  … roster=[Emma, Lee, Mario Sarcher] said="NO"
 *           [Meeting:Heard] item=item-4 transcript="Emma, can you take a look?"
 *
 * `off` omits the `transcript=` token altogether rather than writing an empty one: a
 * line saying `transcript=""` reads like an utterance that had no words in it — and
 * under `off` the `[Meeting:Heard]` line is not written at all.
 *
 * Pure functions, and deliberately no logger import: the caller owns the line.
 */

import { config } from '../../config';

/**
 * Who is in the room, or how many.
 *
 * Behind the same switch as the sentence, for the same reason — these are real
 * people's names. Under `off` the count still carries the diagnostic that matters:
 * the gate is given the roster so it can tell a request aimed at the agent from one
 * aimed at somebody else by name, so `roster=0` explains a verdict that had only
 * word order to go on.
 */
export function formatRoster(roster: string[]): string {
  return config.meetingTranscriptLogging === 'full'
    ? `roster=[${roster.join(', ')}]`
    : `roster=${roster.length}`;
}

/**
 * The sentence, or nothing at all.
 *
 * Returns `''` under `off`, which the caller drops rather than writing an empty token.
 * Nothing stands in for the sentence there — not a length, not a digest. The words
 * arrive after the verdict does, so they go on a line of their own; `item=` is what
 * pairs the two, and it is written at either setting.
 */
export function formatTranscript(transcript: string): string {
  return config.meetingTranscriptLogging === 'full'
    ? `transcript=${JSON.stringify(transcript)}`
    : '';
}

/**
 * The gate model's own words about a verdict, or nothing.
 *
 * `full` only, and it belongs here rather than at the call site so that one module
 * decides what a setting means: its clearest refusals quote the sentence by naming a
 * person in it ("NO, the speaker addresses Isaac"), so this is the transcript wearing a
 * different hat and belongs behind the same switch.
 */
export function formatGateReasoning(text: string): string {
  if (config.meetingTranscriptLogging !== 'full') return '';
  return text.trim().replace(/\s+/g, ' ');
}
