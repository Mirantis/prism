/**
 * A recording of the user's own screen, with the words they said over it.
 *
 * It belongs to the voice call the Computer page started, not to the desktop that page
 * shows: the microphone it takes is the call's, and the model it is handed to is the
 * call's. The desktop outlives any one call, so a recording cannot live there.
 *
 * The page samples the screen it is sharing and hands over the pictures it kept when the
 * recording stops. The microphone the call already carries is diverted here while one
 * runs, so the model hears the narration once, at the end, instead of answering over the
 * demonstration and then being told the same thing again.
 *
 * The result is grouped into windows of a fixed length, each holding the pictures taken
 * in it and the audio recorded over them. That grouping is what a recording has and a
 * shared screen does not: which words go with which picture.
 *
 * Nothing is written to disk. A recording lives for the call it was made in, as the rest
 * of a voice chat does.
 */

import { logger } from '../../logger';
import { trackEvent } from '../../lib/telemetry';
import type { RecordingSegment } from '../meeting/realtime-session';
import { Downsampler, pcm16BytesDurationMs, REALTIME_SAMPLE_RATE } from '../meeting/resampler';

export type { RecordingSegment };

/** The longest recording the runtime keeps. The page stops itself at the same figure. */
export const MAX_RECORDING_MS = 5 * 60_000;
/** How many pictures reach the model. The page selects which ones; this is the ceiling. */
export const MAX_RECORDING_FRAMES = 24;
/** A picture larger than this is refused; a 1280-wide JPEG is an order of magnitude smaller. */
const MAX_FRAME_CHARS = 1024 * 1024;
/** How much of the recording goes in one conversation item. */
const WINDOW_MS = 30_000;

/** The audio the recording keeps, in bytes: its whole length at the model's own rate. */
const MAX_AUDIO_BYTES = Math.ceil((MAX_RECORDING_MS / 1000) * REALTIME_SAMPLE_RATE) * 2;

/** Why a recording ended, as the page reports it. */
export type RecordingEndReason = 'user' | 'limit' | 'share_ended';

/** A finished recording, ready to put in front of the model. */
export interface RecordingResult {
  segments: RecordingSegment[];
  /** How long the recording ran, by the page's clock. */
  ms: number;
  frames: number;
  audioMs: number;
  reason: RecordingEndReason;
}

export interface ScreenRecordingOptions {
  /** The rate the client's audio arrives at. The recording is kept at the model's. */
  clientSampleRate: number;
  /** Who is recording, for the two lifecycle events. */
  userId: string;
}

/** `0:07`, `1:30` — the offset a segment is labelled with. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The window an offset falls in. */
function windowOf(ms: number): number {
  return Math.max(0, Math.floor(ms / WINDOW_MS));
}

export class ScreenRecording {
  private startedAt: number | null = null;
  /** Audio per window, at the model's rate, in arrival order. */
  private audio: Buffer[][] = [];
  private audioBytes = 0;
  /** Pictures as the page sent them, with the offset each was taken at. */
  private frames: { image: string; at: number }[] = [];
  /**
   * The client's rate is 48 kHz on the page that records, and the model's is 24 kHz, so
   * the audio is converted as it arrives rather than at the end: a recording then holds
   * what it will send, at half the bytes.
   */
  private readonly downsampler: Downsampler | null;

  constructor(private readonly options: ScreenRecordingOptions) {
    this.downsampler = options.clientSampleRate === REALTIME_SAMPLE_RATE ? null : new Downsampler();
  }

  /** Begin. A second start while one runs is the page repeating itself, and is ignored. */
  start(): boolean {
    if (this.startedAt !== null) return false;
    this.startedAt = Date.now();
    this.audio = [];
    this.audioBytes = 0;
    this.frames = [];
    this.downsampler?.reset();
    logger.info('[VoiceChat] The user is recording their screen');
    trackEvent('screen recording started', this.options.userId);
    return true;
  }

  /**
   * Take a frame of the client's audio. Answers whether the recording took it, which is
   * what keeps the same frame from also reaching the model live.
   */
  pushAudio(pcm: Buffer): boolean {
    if (this.startedAt === null) return false;
    if (this.audioBytes >= MAX_AUDIO_BYTES) return true;
    const converted = this.downsampler ? this.downsampler.process(pcm) : pcm;
    if (converted.length === 0) return true;
    // Timed here while the pictures are timed in the page, a round trip apart. Windows
    // are half a minute, so the two agree on which one a moment belongs to.
    const index = windowOf(Date.now() - this.startedAt);
    (this.audio[index] ??= []).push(converted);
    this.audioBytes += converted.length;
    return true;
  }

  /** A picture the page kept, with the offset it was taken at. */
  addFrame(data: string, at: number): void {
    if (this.startedAt === null) return;
    if (this.frames.length >= MAX_RECORDING_FRAMES) return;
    if (typeof data !== 'string' || data.length === 0 || data.length > MAX_FRAME_CHARS) return;
    this.frames.push({ image: `data:image/jpeg;base64,${data}`, at: Math.max(0, at) });
  }

  /**
   * Throw away what is held. Nobody is left to hand it to, so it carries no reason.
   *
   * Answers whether a recording was running, so a caller can tell the user's model about
   * the one that will not arrive without announcing a recording nobody made.
   */
  cancel(): boolean {
    if (this.startedAt === null) return false;
    this.finishEvent('cancelled', null, Date.now() - this.startedAt);
    this.clear();
    return true;
  }

  /**
   * End the recording and answer what to put in front of the model.
   *
   * Null when there is nothing in it — a recording so short that no picture was kept and
   * nothing was said. The caller tells the user rather than asking the model to talk
   * about an empty one.
   */
  stop(reason: RecordingEndReason, ms: number): RecordingResult | null {
    if (this.startedAt === null) return null;
    // The page's own figure, since it holds the clock the pictures are stamped against.
    const reported = Number.isFinite(ms) && ms > 0 ? ms : Date.now() - this.startedAt;
    const ran = Math.min(reported, MAX_RECORDING_MS);
    const segments = this.buildSegments();
    const frames = this.frames.length;
    const audioMs = Math.round(pcm16BytesDurationMs(this.audioBytes, REALTIME_SAMPLE_RATE));
    this.finishEvent(segments.length === 0 ? 'empty' : 'delivered', reason, ran, {
      frames: String(frames),
      audio_ms: String(audioMs),
      segments: String(segments.length),
    });
    this.clear();
    logger.info(
      `[VoiceChat] Recording ended after ${formatOffset(ran)} (${reason}): ` +
        `${frames} pictures, ${Math.round(audioMs / 1000)}s of narration`,
    );
    return segments.length === 0 ? null : { segments, ms: ran, frames, audioMs, reason };
  }

  /** The windows, oldest first, with the empty ones left out. */
  private buildSegments(): RecordingSegment[] {
    const byWindow = new Map<number, string[]>();
    for (const frame of this.frames) {
      const index = windowOf(frame.at);
      const images = byWindow.get(index) ?? [];
      images.push(frame.image);
      byWindow.set(index, images);
    }

    const last = Math.max(this.audio.length - 1, ...byWindow.keys(), 0);
    const segments: RecordingSegment[] = [];
    for (let index = 0; index <= last; index++) {
      const images = byWindow.get(index) ?? [];
      const audio = Buffer.concat(this.audio[index] ?? []);
      if (images.length === 0 && audio.length === 0) continue;
      segments.push({ label: formatOffset(index * WINDOW_MS), images, audio });
    }
    return segments;
  }

  private finishEvent(
    status: 'delivered' | 'empty' | 'cancelled',
    reason: RecordingEndReason | null,
    ms: number,
    extra: Record<string, string> = {},
  ): void {
    trackEvent('screen recording finished', this.options.userId, {
      status,
      ...(reason ? { reason } : {}),
      duration_ms: String(Math.round(ms)),
      ...extra,
    });
  }

  private clear(): void {
    this.startedAt = null;
    this.audio = [];
    this.audioBytes = 0;
    this.frames = [];
  }
}
