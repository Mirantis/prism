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
 */

import { logger } from '../../logger';
import { pcm16BytesDurationMs, pcm16BytesForMs, pcm16DurationMs } from './resampler';

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

export class AudioPlayback {
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private disposed = false;
  private timer: NodeJS.Timeout | null = null;

  /** Playback clock: real time at which the current run of audio began. */
  private startedAt: number | null = null;
  private firstEnqueueAt: number | null = null;
  /** Total audio handed to the sink since the clock started. */
  private writtenMs = 0;

  /**
   * `sampleRate` is required rather than defaulted.
   *
   * Every millisecond this class computes — the pre-roll and the lead it chases —
   * comes from it. A default would be
   * invisible in review and audible in production: 24 kHz audio paced as 48 kHz
   * writes at half the rate the device drains.
   */
  constructor(
    private readonly sink: PlaybackSink,
    private readonly sampleRate: number,
  ) {}

  /** Queue model speech. */
  enqueue(pcm: Buffer): void {
    if (this.disposed || pcm.length === 0) return;
    this.queue.push(pcm);
    this.queuedBytes += pcm.length;
    if (this.firstEnqueueAt === null) this.firstEnqueueAt = Date.now();
    this.ensureTimer();
  }

  /**
   * Drop everything unplayed, here and in the sink.
   *
   * The tail already inside the device (at most `TARGET_LEAD_MS`) still plays; it
   * cannot be recalled, which is exactly why that number is kept small.
   */
  flush(): void {
    this.queue = [];
    this.queuedBytes = 0;
    this.firstEnqueueAt = null;
    this.stopTimer();
    this.clearSink();
  }

  private ensureTimer(): void {
    if (this.timer || this.disposed) return;
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
    if (this.disposed) return;
    if (this.queue.length === 0) {
      // Nothing left to hand over: stop spinning the timer.
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
    if (head.length <= wantBytes) {
      piece = head;
      this.queue.shift();
    } else {
      piece = head.subarray(0, wantBytes);
      this.queue[0] = head.subarray(wantBytes);
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

    this.writtenMs += pcm16DurationMs(piece, this.sampleRate);
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
