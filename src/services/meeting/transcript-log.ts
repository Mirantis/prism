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
 *     off   [Meeting:Gate] final verdict addressed=false item=item-4 mode=addressed keywords=3
 *     full  … keywords=[Emma, Lee, Mario Sarcher] transcript="Emma, can you take a look?"
 *
 * `off` omits the `transcript=` token altogether rather than writing an empty one: a
 * line saying `transcript=""` reads like an utterance that had no words in it.
 *
 * Pure functions, and deliberately no logger import: the caller owns the line.
 */

import { config } from '../../config';

/**
 * The keyword list, or how long it was.
 *
 * The names are the room's, so under `off` only the count is written. The count still
 * carries the diagnostic that matters: the agent's own name always leads the list, so
 * `keywords=1` says no roster has arrived yet and `keywords=0` would say something is
 * wrong with the seeding.
 */
export function formatKeywords(keywords: string[]): string {
  return config.meetingTranscriptLogging === 'full'
    ? `keywords=[${keywords.join(', ')}]`
    : `keywords=${keywords.length}`;
}

/**
 * The sentence, or nothing at all.
 *
 * Returns `''` under `off`, which the caller drops rather than writing an empty token.
 * Nothing stands in for the sentence there — not a length, not a digest. Pairing the
 * partial verdict on one utterance with its final verdict is `item=`, which is written
 * at either setting, so the line keeps that much without the words.
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
