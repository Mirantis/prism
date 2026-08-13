/**
 * The call's running transcript, in a shape a prompt cache can actually hit.
 *
 * A delegated request used to carry only what the voice model retyped about the
 * conversation, which is the one part of a meeting nobody can write down faithfully
 * while also talking. This holds the conversation itself so every handoff can carry
 * it, and it is built for *re-sending*: the same bytes go out on every delegation in
 * a call, so what matters is that they stay the same bytes.
 *
 * Prompt caching is prefix matching over content blocks, and two properties of it
 * shape everything here:
 *
 * 1. **A cache entry exists only at a block boundary.** A single block that grows by
 *    a sentence between calls is a different block each time, so it would never be
 *    read from cache no matter where the breakpoint sat. The log therefore hands out
 *    two pieces: `sealed`, which only ever changes in ~4,000-character quanta, and
 *    `open`, the lines said since the last seal. The caller caches the first and
 *    re-sends the second uncached — a few hundred tokens.
 * 2. **Any byte change invalidates everything after it.** So the log is append-only
 *    in the middle: nothing rewrites a sealed chunk, and the cap is enforced by
 *    dropping whole oldest chunks rather than sliding a window over the text. A drop
 *    costs one cache write; a sliding window would cost one per delegation, which is
 *    the failure mode this file exists to avoid.
 *
 * It is deliberately not a record of the meeting: it lives in memory for the length
 * of one call, is never persisted, and nothing outside a delegated prompt reads it.
 */

/**
 * How much text a chunk is sealed at.
 *
 * The trade is write cost against read coverage. Sealing rarely (a big quantum) means
 * more of the transcript sits in the uncached tail; sealing often (a small one) means
 * more cache writes, each billed at 1.25x. Four thousand characters is roughly a
 * thousand tokens — comfortably above every model's minimum cacheable prefix, and
 * about a minute or two of a busy room, so the tail stays small between seals.
 */
export const TRANSCRIPT_CHUNK_CHARS = 4_000;

/**
 * The most transcript any one handoff carries.
 *
 * An hour-long call can outgrow a context window, and the delegate needs room for its
 * own tool output on top. Forty thousand characters (~10k tokens) keeps the oldest of
 * a long meeting rather than the newest — the opposite of what a summary would do —
 * and is a cap on the *prompt*, not on the log's usefulness: what is dropped is what
 * the room itself has mostly stopped referring to.
 */
export const TRANSCRIPT_MAX_CHARS = 40_000;

/**
 * What stands in for chunks the cap dropped.
 *
 * Fixed text, and placed at the very front, because it is part of the cached prefix:
 * a marker that counted what it had dropped would change on every drop and invalidate
 * the transcript behind it a second time.
 */
export const TRANSCRIPT_OMISSION_MARKER = '[earlier conversation omitted]';

/** Who said a line. The room is unlabeled by nature — the audio is a mixed channel. */
export type TranscriptSpeaker = 'room' | 'agent';

/** The transcript split where a cache breakpoint can usefully go. */
export interface TranscriptChunks {
  /**
   * Everything sealed into quanta — byte-identical between seals, so this is the part
   * worth a breakpoint. Empty until the first seal.
   */
  sealed: string;
  /** Lines said since the last seal. Changes constantly; send it uncached. */
  open: string;
}

/** Counts for telemetry. Sizes and totals only — never the text. */
export interface TranscriptStats {
  lines: number;
  chars: number;
  sealedChars: number;
  openChars: number;
  droppedChunks: number;
}

export interface TranscriptLog {
  /**
   * Record one finished utterance. Whitespace-only text is ignored — a transcription
   * that trimmed to nothing is not a line of conversation.
   */
  append(text: string, speaker?: TranscriptSpeaker): void;
  chunks(): TranscriptChunks;
  stats(): TranscriptStats;
}

export interface TranscriptLogOptions {
  chunkChars?: number;
  maxChars?: number;
}

/** How a line is labeled. Short, because the label is paid for on every delegation. */
const LABELS: Record<TranscriptSpeaker, string> = {
  room: 'Room:',
  agent: 'You:',
};

/**
 * One call's log. Created per meeting and shared by the conversation (which writes
 * the room's speech into it) and the delegation tool (which reads it, and writes its
 * own answers back so the next handoff knows what was already said).
 */
export function createTranscriptLog(options: TranscriptLogOptions = {}): TranscriptLog {
  const chunkChars = options.chunkChars ?? TRANSCRIPT_CHUNK_CHARS;
  const maxChars = options.maxChars ?? TRANSCRIPT_MAX_CHARS;

  /** Sealed quanta, oldest first. Never modified once pushed — only dropped. */
  const sealed: string[] = [];
  let sealedChars = 0;
  let open: string[] = [];
  let openChars = 0;
  let lines = 0;
  let droppedChunks = 0;

  /** Cached rendering of `sealed`, so a re-read doesn't re-join the whole transcript. */
  let sealedText = '';

  const renderSealed = (): void => {
    const body = sealed.join('\n');
    sealedText = droppedChunks > 0 ? `${TRANSCRIPT_OMISSION_MARKER}\n${body}` : body;
  };

  const seal = (): void => {
    if (open.length === 0) return;
    const chunk = open.join('\n');
    sealed.push(chunk);
    sealedChars += chunk.length;
    open = [];
    openChars = 0;

    // Drop from the front until the cap holds. Whole chunks, so what stays keeps its
    // bytes — a partial trim would rewrite the chunk it cut into and cost a cache
    // write on every delegation after it, rather than one write here.
    //
    // Counted on the chunks' own lengths, so the rendered block can sit a few tens of
    // characters over the cap: the newlines joining the chunks and the omission marker
    // are not in the sum. The cap is a budget, not a boundary anything depends on.
    while (sealedChars > maxChars && sealed.length > 1) {
      const dropped = sealed.shift();
      /* c8 ignore next -- length is checked above; this satisfies the type */
      if (dropped === undefined) break;
      sealedChars -= dropped.length;
      droppedChunks += 1;
    }

    renderSealed();
  };

  return {
    append(text: string, speaker: TranscriptSpeaker = 'room'): void {
      const trimmed = text.trim();
      if (!trimmed) return;

      const line = `${LABELS[speaker]} ${trimmed}`;
      open.push(line);
      // The newline each line but the first costs, so the seal threshold sees the
      // length the prompt will actually carry.
      openChars += line.length + (open.length > 1 ? 1 : 0);
      lines += 1;

      if (openChars >= chunkChars) seal();
    },

    chunks(): TranscriptChunks {
      return { sealed: sealedText, open: open.join('\n') };
    },

    stats(): TranscriptStats {
      return {
        lines,
        chars: sealedText.length + openChars,
        sealedChars: sealedText.length,
        openChars,
        droppedChunks,
      };
    },
  };
}
