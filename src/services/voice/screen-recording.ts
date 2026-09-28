/**
 * A recording of the user's own screen, while they talk the agent through it.
 *
 * It belongs to the voice call the Computer page started, not to the desktop that page
 * shows: the model it is handed to is the call's. The desktop outlives any one call, so a
 * recording cannot live there.
 *
 * The page samples the screen it is sharing and hands over the pictures it kept when the
 * recording stops. The user's narration travels live, as the rest of the call does, so
 * the voice hears it as it is said and is told to stay quiet until the pictures arrive.
 *
 * The pictures are grouped into windows of a fixed length, each labelled with where it
 * starts, so the model can match a picture to the moment it was said about.
 *
 * Nothing is written to disk. A recording lives for the call it was made in, as the rest
 * of a voice chat does.
 */

import { logger } from '../../logger';
import { trackEvent } from '../../lib/telemetry';
import type { RecordingSegment } from '../meeting/voice-conversation';

export type { RecordingSegment };

/** The longest recording the runtime keeps. The page stops itself at the same figure. */
export const MAX_RECORDING_MS = 5 * 60_000;
/** How many pictures reach the model. The page selects which ones; this is the ceiling. */
export const MAX_RECORDING_FRAMES = 24;
/** A picture larger than this is refused; a 1280-wide JPEG is an order of magnitude smaller. */
const MAX_FRAME_CHARS = 1024 * 1024;
/** How much of the recording one label covers. */
const WINDOW_MS = 30_000;

/** Why a recording ended, as the page reports it. */
export type RecordingEndReason = 'user' | 'limit' | 'share_ended';

/** A finished recording, ready to put in front of the model. */
export interface RecordingResult {
  segments: RecordingSegment[];
  /** How long the recording ran, by the page's clock. */
  ms: number;
  frames: number;
  reason: RecordingEndReason;
}

export interface ScreenRecordingOptions {
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
  /** Pictures as the page sent them, with the offset each was taken at. */
  private frames: { image: string; at: number }[] = [];

  constructor(private readonly options: ScreenRecordingOptions) {}

  /** Begin. A second start while one runs is the page repeating itself, and is ignored. */
  start(): boolean {
    if (this.startedAt !== null) return false;
    this.startedAt = Date.now();
    this.frames = [];
    logger.info('[VoiceChat] The user is recording their screen');
    trackEvent('screen recording started', this.options.userId);
    return true;
  }

  /**
   * A picture the page kept, with the offset it was taken at.
   *
   * The offset is the page's claim rather than a fact, and it becomes the label the model
   * reads. One outside the length a recording may run is refused rather than clamped,
   * since clamping would file the picture under a time it was not taken at.
   */
  addFrame(data: string, at: number): void {
    if (this.startedAt === null) return;
    if (this.frames.length >= MAX_RECORDING_FRAMES) return;
    if (typeof data !== 'string' || data.length === 0 || data.length > MAX_FRAME_CHARS) return;
    if (!Number.isFinite(at) || at < 0 || at > MAX_RECORDING_MS) return;
    this.frames.push({ image: `data:image/jpeg;base64,${data}`, at });
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
   * Null when there is nothing in it — a recording so short that no picture was kept. The caller tells the user rather than asking the model to talk
   * about an empty one.
   */
  stop(reason: RecordingEndReason, ms: number): RecordingResult | null {
    if (this.startedAt === null) return null;
    // The page's own figure, since it holds the clock the pictures are stamped against.
    const reported = Number.isFinite(ms) && ms > 0 ? ms : Date.now() - this.startedAt;
    const ran = Math.min(reported, MAX_RECORDING_MS);
    const segments = this.buildSegments();
    const frames = this.frames.length;
    this.finishEvent(segments.length === 0 ? 'empty' : 'delivered', reason, ran, {
      frames: String(frames),
      segments: String(segments.length),
    });
    this.clear();
    logger.info(`[VoiceChat] Recording ended after ${formatOffset(ran)} (${reason}): ${frames} pictures`);
    return segments.length === 0 ? null : { segments, ms: ran, frames, reason };
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

    return [...byWindow.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, images]) => ({ label: formatOffset(index * WINDOW_MS), images }));
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
    this.frames = [];
  }
}
