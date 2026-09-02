/**
 * Playback of the model's speech into the meeting.
 *
 * This file has been wrong twice in opposite directions, and both failures are worth
 * recording because the fix is the thing in between.
 *
 * **First attempt: meter one 20 ms frame per `setInterval` tick.** Barge-in was
 * instant (nothing was committed ahead of time) but the audio was rough: Node timers
 * are not a clock, so a GC pause or a tool call landing mid-sentence delivered a
 * frame late, PulseAudio ran dry, and the listener heard a click or a chopped
 * syllable.
 *
 * **Second attempt: push as fast as the pipe accepts and let PulseAudio pace it.**
 * The audio became smooth and the interruption became terrible. Writing eagerly
 * fills the OS pipe (64 kB ≈ 680 ms of speech), Node's stream buffer (≈170 ms) and
 * the device buffer — so when a human interrupted, up to a second of speech was
 * already committed and unrecallable. The bot talked over them, exactly as reported.
 *
 * **What actually works: stay a fixed, small distance ahead of real time.** We keep
 * our own clock, but instead of writing a fixed amount per tick we compute how much
 * *should* have been handed over by now and write the difference. A late tick simply
 * writes more to catch up, so jitter can't starve the device — that was the flaw in
 * the first attempt — while nothing is ever committed more than `TARGET_LEAD_MS`
 * ahead, which bounds how long the bot can keep talking after being cut off.
 *
 * Having a real clock also makes the played-ms *measured* rather than estimated,
 * which is what `conversation.item.truncate` needs to be honest.
 */

import { logger } from '../../logger';
import {
  pcm16BytesDurationMs,
  pcm16BytesForMs,
  pcm16DurationMs,
} from './resampler';

/**
 * How far ahead of real time audio may be handed to the device.
 *
 * This is the single number that trades smoothness against interruption latency:
 * it is both the cushion that absorbs event-loop jitter and the maximum amount of
 * speech that cannot be recalled when someone interrupts. 150 ms is comfortably
 * above the worst scheduling delay we see and short enough to read as instant.
 */
const TARGET_LEAD_MS = 150;

/**
 * Buffer `pacat` requests from PulseAudio, and therefore the most it will hold.
 *
 * Kept slightly above `TARGET_LEAD_MS` so the device always has somewhere to put
 * what we hand it, but no larger: anything buffered here is also unrecallable.
 */
export const SINK_BUFFER_MS = 200;

/** How often to reconsider how much should have been written by now. */
const TICK_MS = 20;

/**
 * Audio to accumulate before the first write of a phrase.
 *
 * Without it the device starts on the first fragment and can drain before the next
 * one arrives, which is what clipped the opening words.
 */
const PREROLL_MS = 100;

/** Start anyway if the pre-roll never fills — a short reply may be all there is. */
const PREROLL_DEADLINE_MS = 250;

/** Where audio is written — `pacat`'s stdin in production. */
export interface PlaybackSink {
  write(chunk: Buffer): boolean | void;
  /**
   * Drop audio queued beyond this process, if the far end holds any.
   *
   * A local device does not: `pacat` plays what it is given as fast as it is
   * written, so the only unrecallable audio is the `TARGET_LEAD_MS` already
   * committed, and this stays unimplemented there. A sink that writes to a
   * client across a network is the case it exists for — everything written is
   * sitting in that client's buffer, and without being told to drop it the
   * agent keeps talking after being interrupted.
   */
  clear?(): void;
}

interface QueuedChunk {
  itemId: string;
  chunk: Buffer;
}

/**
 * What became of one response item's audio when playback was cut short.
 *
 * Both numbers are needed: `playedMs` is what the room heard, `sentMs` is what
 * reached the device at all, and the truncation point OpenAI recommends is derived
 * from the pair rather than from either alone.
 */
export interface PlaybackSnapshot {
  itemId: string;
  playedMs: number;
  sentMs: number;
}

export class AudioPlayback {
  /** FIFO across items — see `enqueue` for why items are not discarded. */
  private queue: QueuedChunk[] = [];
  private queuedBytes = 0;
  private paused = false;
  private disposed = false;
  private timer: NodeJS.Timeout | null = null;

  /** Playback clock: real time at which the current run of audio began. */
  private startedAt: number | null = null;
  private firstEnqueueAt: number | null = null;
  /** Total audio handed to the sink since the clock started. */
  private writtenMs = 0;
  /** Per-item totals, so truncation can be reported against the right item. */
  private writtenMsByItem = new Map<string, number>();
  /** Item of the most recently written chunk — the one currently audible. */
  private writingItem: string | null = null;

  /**
   * `sampleRate` is required rather than defaulted.
   *
   * Every millisecond this class computes — the pre-roll, the lead it chases, the
   * `playedMs` it reports for truncation — comes from it. A default would be
   * invisible in review and audible in production: 24 kHz audio paced as 48 kHz
   * writes at half the rate the device drains, and reports twice the audio as
   * heard.
   */
  constructor(
    private readonly sink: PlaybackSink,
    private readonly sampleRate: number,
  ) {}

  /**
   * Enqueue model speech for a response item.
   *
   * Items are appended, never allowed to displace one another. An earlier version
   * cleared the queue whenever a new item id appeared, which produced a subtle and
   * very audible bug: the model says "let me check that", calls a tool, and the
   * follow-up response arrives as a *new* item — dropping the unplayed part of the
   * filler and cutting the bot off mid-word. It sounded like the bot interrupting
   * itself, because it was. Stale audio after a real interruption is handled where
   * it belongs, by `RealtimeSession` refusing to forward deltas for an abandoned
   * item.
   */
  enqueue(pcm48k: Buffer, itemId: string): void {
    if (this.disposed || pcm48k.length === 0) return;
    this.queue.push({ itemId, chunk: pcm48k });
    this.queuedBytes += pcm48k.length;
    if (this.firstEnqueueAt === null) this.firstEnqueueAt = Date.now();
    this.ensureTimer();
  }

  /** Stop handing over audio, keeping the queue for a possible resume. */
  pause(): void {
    this.paused = true;
  }

  /** Resume after a pause that turned out not to be a real interruption. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.ensureTimer();
  }

  /**
   * Drop everything unplayed and report what was heard, per response item.
   *
   * A list rather than a single item, because `gpt-realtime-2.x` speaks a native
   * preamble ("let me check that") as its own `commentary` item and then the answer
   * as a `final_answer` item — one turn, two or more audio items. Truncating only
   * the newest leaves the preamble's unheard tail in the model's context, so every
   * item that received audio is reported: earlier ones were heard in full, the
   * audible one partially, and anything still queued was never heard at all.
   *
   * The tail already inside the device (at most `TARGET_LEAD_MS`) still plays; it
   * cannot be recalled, which is exactly why that number is kept small.
   */
  flush(): PlaybackSnapshot[] {
    const outstanding = this.outstandingMs;
    const items: PlaybackSnapshot[] = [];
    for (const [itemId, sentMs] of this.writtenMsByItem) {
      // Only the item still being written can have audio outstanding; everything
      // before it has already gone out and been heard.
      const playedMs = itemId === this.writingItem ? Math.max(0, sentMs - outstanding) : sentMs;
      items.push({ itemId, playedMs, sentMs });
    }
    // Items whose audio arrived but never reached the device were heard for 0ms;
    // they still need truncating or their transcript stays in context.
    for (const queued of this.queue) {
      if (!this.writtenMsByItem.has(queued.itemId) && !items.some((i) => i.itemId === queued.itemId)) {
        items.push({ itemId: queued.itemId, playedMs: 0, sentMs: 0 });
      }
    }

    this.queue = [];
    this.queuedBytes = 0;
    this.paused = false;
    this.firstEnqueueAt = null;
    this.writtenMsByItem.clear();
    this.writingItem = null;
    this.stopTimer();
    // Told after the snapshots are taken, not before: the numbers above describe
    // what the far end heard, and a sink that drops its own queue changes what it
    // is about to play rather than what it already did.
    this.clearSink();
    return items;
  }

  /**
   * Whether the bot still has speech to deliver.
   *
   * Counts audio already handed to the device as well as what is queued: during
   * that window the room can still hear it, so an interruption is meaningful.
   */
  get isSpeaking(): boolean {
    return this.queuedBytes > 0 || this.outstandingMs > TICK_MS;
  }

  /** Audio handed over but not yet heard. */
  private get outstandingMs(): number {
    if (this.startedAt === null) return 0;
    return Math.max(0, this.writtenMs - (Date.now() - this.startedAt));
  }

  /**
   * Milliseconds of the audible item the room has actually heard.
   *
   * Measured from the clock rather than inferred from a fixed buffer depth, so it
   * is what `conversation.item.truncate` should be told.
   */
  get currentPlayedMs(): number {
    if (!this.writingItem) return 0;
    const written = this.writtenMsByItem.get(this.writingItem) ?? 0;
    return Math.max(0, written - this.outstandingMs);
  }

  private ensureTimer(): void {
    if (this.timer || this.paused || this.disposed) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.tick();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.paused || this.disposed) return;
    if (this.queue.length === 0) {
      // Nothing left to hand over. Keep the clock so `outstandingMs` stays honest
      // while the device drains, but stop spinning the timer.
      this.stopTimer();
      return;
    }

    if (!this.readyToStart()) return;

    const now = Date.now();
    if (this.startedAt === null) this.startedAt = now;
    // If the device has drained (a gap between phrases), rebase the clock. Without
    // this the elapsed time would race ahead of what we have written and the next
    // phrase would be dumped in one burst, undoing the whole point of pacing.
    const elapsed = now - this.startedAt;
    if (elapsed > this.writtenMs) {
      this.startedAt = now - this.writtenMs;
    }

    const target = (this.startedAt === null ? 0 : now - this.startedAt) + TARGET_LEAD_MS;
    while (this.writtenMs < target && this.queue.length > 0) {
      if (!this.writeOneChunk(target)) return;
    }
  }

  /** Hold the first write until there is enough audio to survive a hiccup. */
  private readyToStart(): boolean {
    if (this.startedAt !== null) return true;
    if (pcm16BytesDurationMs(this.queuedBytes, this.sampleRate) >= PREROLL_MS) return true;
    return this.firstEnqueueAt !== null && Date.now() - this.firstEnqueueAt >= PREROLL_DEADLINE_MS;
  }

  /**
   * Write at most enough to reach `target`, splitting a chunk when it overshoots.
   *
   * Splitting matters: a single delta can be hundreds of milliseconds long, and
   * handing it over whole would blow past the lead we are trying to hold.
   */
  private writeOneChunk(target: number): boolean {
    const head = this.queue[0];
    const remainingMs = target - this.writtenMs;
    const wantBytes = Math.max(pcm16BytesForMs(remainingMs, this.sampleRate), 2);

    let piece: Buffer;
    if (head.chunk.length <= wantBytes) {
      piece = head.chunk;
      this.queue.shift();
    } else {
      piece = head.chunk.subarray(0, wantBytes);
      head.chunk = head.chunk.subarray(wantBytes);
    }
    this.queuedBytes -= piece.length;

    try {
      this.sink.write(piece);
    } catch (err) {
      logger.error({ err }, '[Meeting] Playback sink write failed');
      this.queue = [];
      this.queuedBytes = 0;
      this.stopTimer();
      return false;
    }

    const ms = pcm16DurationMs(piece, this.sampleRate);
    this.writtenMs += ms;
    this.writingItem = head.itemId;
    this.writtenMsByItem.set(head.itemId, (this.writtenMsByItem.get(head.itemId) ?? 0) + ms);
    return true;
  }

  /** Release resources. Safe to call more than once. */
  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.stopTimer();
    this.clearSink();
  }

  /**
   * Ask the sink to drop what it holds, when it holds anything.
   *
   * Never throws upward: this runs while a call is being interrupted or torn
   * down, and a sink that will not clear must not stop either from finishing.
   */
  private clearSink(): void {
    try {
      this.sink.clear?.();
    } catch (err) {
      logger.warn({ err }, '[Meeting] Playback sink would not clear');
    }
  }
}
