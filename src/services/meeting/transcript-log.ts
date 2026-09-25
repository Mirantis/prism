/**
 * What a call's words are allowed to look like in a log line.
 *
 * `MEETING_TRANSCRIPT_LOGGING` is the one switch that chooses whether any of them are
 * written (see config.ts for why the default is `off` and why it is a variable of its own
 * rather than a log level).
 *
 *     full  [Voice:Heard] transcript="Emma, can you take a look?"
 *
 * Pure, and no logger import: the caller owns the line.
 */

import { config } from '../../config';

/** The sentence, or `''` under `off`, which the caller drops rather than writing. */
export function formatTranscript(transcript: string): string {
  return config.meetingTranscriptLogging === 'full'
    ? `transcript=${JSON.stringify(transcript)}`
    : '';
}
