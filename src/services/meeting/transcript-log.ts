/**
 * What a meeting's words are allowed to look like in a log line.
 *
 * A call's utterances used to be logged verbatim, at `info`, next to the roster of
 * everyone in the room — a diagnostic that was genuinely useful and quietly turned the
 * deployment's log into a transcript of a conversation nobody in the room consented to.
 * These formatters are the only place that decides how much of it is written, and
 * `MEETING_TRANSCRIPT_LOGGING` is what chooses (see config.ts for why the default is
 * `off`).
 *
 *     off       [Meeting:Gate] final verdict addressed=false item=item-4 mode=addressed keywords=3
 *     redacted  … keywords=3 chars=26 sha256=1f4a9c2b
 *     full      … keywords=[Emma, Lee, Mario Sarcher] transcript="Emma, can you take a look?"
 *
 * `off` omits the `transcript=` token altogether rather than writing an empty one: a
 * line saying `transcript=""` reads like an utterance that had no words in it.
 * `redacted` writes `chars=` and `sha256=` as tokens of their own for the same reason —
 * they are facts about the sentence, not a redacted rendering of it.
 *
 * Pure functions, and deliberately no logger import: the caller owns the line.
 */

import { createHash, randomBytes } from 'crypto';
import { config } from '../../config';

/**
 * Salt, so a digest cannot be tested against a guess.
 *
 * A truncated unsalted digest is not an anonymisation of a short sentence — anyone
 * holding the log can hash a sentence they suspect was said and compare. Telling one
 * sentence in a call apart from another is only ever needed *within* one process, so a
 * per-process salt costs the mode nothing and takes away the confirmation attack.
 */
const DIGEST_SALT = randomBytes(16);

/** Enough to tell two sentences apart in one call, too little to enumerate. */
const DIGEST_CHARS = 8;

/**
 * The keyword list, or how long it was.
 *
 * The names are the room's, so under anything but `full` only the count is written.
 * The count still carries the diagnostic that matters: the agent's own name always
 * leads the list, so `keywords=1` says no roster has arrived yet and `keywords=0`
 * would say something is wrong with the seeding.
 */
export function formatKeywords(keywords: string[]): string {
  return config.meetingTranscriptLogging === 'full'
    ? `keywords=[${keywords.join(', ')}]`
    : `keywords=${keywords.length}`;
}

/**
 * The sentence, a fingerprint of it, or nothing at all.
 *
 * Returns `''` under `off`, which the caller drops rather than writing an empty token.
 *
 * What the fingerprint is for: telling one sentence in a call apart from another
 * without recording either. Two lines carrying the same digest were judged on the same
 * words — a transcriber stuck on a sentence, or a room repeating itself — and `chars=`
 * says whether the transcriber produced a plausible sentence at all, which a three-
 * character "final" transcript answers on its own. It is *not* how the partial verdict
 * and the final one on a single utterance are paired: a partial is a prefix of the
 * finished text, so it has a digest of its own. `item=` is what pairs those, at every
 * setting.
 */
export function formatTranscript(transcript: string): string {
  if (config.meetingTranscriptLogging === 'full') return `transcript=${JSON.stringify(transcript)}`;
  if (config.meetingTranscriptLogging === 'redacted') {
    const digest = createHash('sha256')
      .update(DIGEST_SALT)
      .update(transcript)
      .digest('hex')
      .slice(0, DIGEST_CHARS);
    return `chars=${transcript.length} sha256=${digest}`;
  }
  return '';
}

/**
 * The gate model's own words about a verdict, or nothing.
 *
 * `full` only, and it belongs here rather than at the call site so that one module
 * decides what a mode means: its clearest refusals quote the sentence by naming a
 * person in it ("NO, the speaker addresses Isaac"), so this is the transcript wearing
 * a different hat and `redacted` — which reduces the sentence to a digest — cannot
 * write it out and still mean anything.
 */
export function formatGateReasoning(text: string): string {
  if (config.meetingTranscriptLogging !== 'full') return '';
  return text.trim().replace(/\s+/g, ' ');
}
