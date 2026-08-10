/**
 * Paced playback of the model's speech into the meeting, with an accurate count
 * of how much was actually heard.
 *
 * Two problems this solves, both of which come from the Realtime API delivering
 * audio far faster than real time:
 *
 * 1. **Interruption needs an accurate played-ms.** If we wrote every delta
 *    straight to the sink, the OS pipe and PulseAudio's own buffer would hold
 *    seconds of unplayed audio, and "bytes written" would badly overstate what
 *    the room heard. Truncating the model's context at that number makes it think
 *    it said things nobody heard. So playback is metered here, one small frame at
 *    a time on a timer, and the counter only advances as frames go out.
 *
 * 2. **A barge-in must be able to drop unplayed audio.** Once the bytes are in
 *    PulseAudio's buffer they *will* be heard — the bot keeps talking for seconds
 *    after being interrupted. Keeping the queue in this process means a flush is
 *    instantaneous.
 *
 * The frame size is the latency/efficiency trade-off: 20 ms is one write every
 * 20 ms (cheap) and bounds the un-droppable audio to 20 ms (inaudible).
 */

import { logger } from '../../logger';
import { MEETING_SAMPLE_RATE, pcm16BytesForMs, pcm16DurationMs } from './resampler';

/** Playback frame duration. Also the granularity of the played-ms counter. */
const FRAME_MS = 20;
const FRAME_BYTES = pcm16BytesForMs(FRAME_MS, MEETING_SAMPLE_RATE);

/** Where paced audio is written — `pacat`'s stdin in production. */
export interface PlaybackSink {
  write(chunk: Buffer): void;
}

/**
 * Meters model speech into the meeting sink and tracks what has been heard.
 *
 * Queued audio is already at the meeting's 48 kHz rate; the played-ms counter is
 * reported in the Realtime API's own timebase (the item's audio timeline) because
 * that is what `conversation.item.truncate` expects. Since resampling preserves
 * duration, the two agree.
 */
export class AudioPlayback {
  private queue: Buffer[] = [];
  private timer: NodeJS.Timeout | null = null;
  private paused = false;
  /** Milliseconds of the current item that have actually gone out. */
  private playedMs = 0;
  private itemId: string | null = null;

  constructor(private readonly sink: PlaybackSink) {}

  /**
   * Enqueue model speech for the given response item.
   *
   * A new item id means a new utterance: the counter restarts, since truncation
   * is per-item. Any leftover audio from a previous item is dropped rather than
   * played under the new item's identity — it belongs to a response the model has
   * already moved on from.
   */
  enqueue(pcm48k: Buffer, itemId: string): void {
    if (itemId && itemId !== this.itemId) {
      this.itemId = itemId;
      this.queue = [];
      this.playedMs = 0;
      this.paused = false;
    }
    this.queue.push(pcm48k);
    this.ensureTimer();
  }

  /** Stop emitting immediately, keeping the queue for a possible resume. */
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
   * Drop all unplayed audio and report how much of the item was heard.
   *
   * The return value is what goes into `conversation.item.truncate`.
   */
  flush(): { itemId: string | null; playedMs: number } {
    const result = { itemId: this.itemId, playedMs: this.playedMs };
    this.queue = [];
    this.paused = false;
    this.stopTimer();
    // Forget the item as well as its audio. The session drops the abandoned
    // utterance's remaining deltas, but if one did arrive it must be treated as a
    // new utterance rather than appended to the one we just stopped playing.
    this.itemId = null;
    return result;
  }

  /** True while audio is queued or mid-utterance — i.e. the bot is speaking. */
  get isSpeaking(): boolean {
    return this.queue.length > 0;
  }

  get currentPlayedMs(): number {
    return this.playedMs;
  }

  private ensureTimer(): void {
    if (this.timer || this.paused) return;
    this.timer = setInterval(() => this.tick(), FRAME_MS);
    // Emit the first frame immediately so speech starts without a frame of delay.
    this.tick();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.paused) return;
    if (this.queue.length === 0) {
      // Nothing left to play — stop the timer rather than spin at 50 Hz. It is
      // restarted by the next enqueue.
      this.stopTimer();
      return;
    }

    const frame = this.takeFrame();
    if (frame.length === 0) return;

    try {
      this.sink.write(frame);
    } catch (err) {
      logger.error({ err }, '[Meeting] Playback sink write failed');
      this.queue = [];
      this.stopTimer();
      return;
    }
    this.playedMs += pcm16DurationMs(frame, MEETING_SAMPLE_RATE);
  }

  /** Pull up to one frame out of the queue, splicing across chunk boundaries. */
  private takeFrame(): Buffer {
    const parts: Buffer[] = [];
    let needed = FRAME_BYTES;

    while (needed > 0 && this.queue.length > 0) {
      const head = this.queue[0];
      if (head.length <= needed) {
        parts.push(head);
        needed -= head.length;
        this.queue.shift();
      } else {
        parts.push(head.subarray(0, needed));
        this.queue[0] = head.subarray(needed);
        needed = 0;
      }
    }

    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  /** Release the timer. Safe to call more than once. */
  dispose(): void {
    this.queue = [];
    this.stopTimer();
  }
}
