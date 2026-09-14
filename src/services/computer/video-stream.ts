/**
 * The whole virtual display as video for the page.
 *
 * `ffmpeg` grabs the X display and encodes it as H.264, which sends what changed rather
 * than a whole picture each time: a desktop with a cursor blinking in it costs a few dozen
 * bytes a frame, where a picture of the same desktop costs fifty kilobytes. The encoder is
 * asked to mark where each picture begins, so this forwards whole pictures without reading
 * any further into them (see `h264.ts`).
 *
 * The page is told the stream's name before the first picture, and again whenever the
 * encoder restarts, since a stream that starts over is a new stream to a decoder.
 */

import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../../logger';
import { codecFrom, isKeyframe, splitAccessUnits } from './h264';
import type { PictureStream, ScreenFrame } from './picture-stream';

const FRAMES_PER_SECOND = 30;
/**
 * How hard the encoder works and how much it keeps.
 *
 * `veryfast` costs less than encoding a JPEG of every frame did, and 23 keeps text on the
 * desktop sharp enough to read, which is most of what is on it.
 */
const PRESET = 'veryfast';
const QUALITY = 23;
/**
 * How often a picture that stands on its own goes out, in frames.
 *
 * One client watches one stream from its start, so these are not needed to join. They are
 * what a client that fell behind comes back on, and each one costs about as much as a
 * whole JPEG, so they are rare.
 */
const KEYFRAME_INTERVAL = 150;
/** A capture that has shown nothing by now is not going to; say so in the log. */
const FIRST_FRAME_TIMEOUT_MS = 5_000;

export class VideoStream implements PictureStream {
  private proc: ChildProcess | null = null;
  private pending: Buffer = Buffer.alloc(0);
  /** Pictures the encoder produced. */
  private framesSeen = 0;
  /** Whether the page has been told this encoder's name yet. */
  private announced = false;
  private firstFrameTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  /** `display` is the X display, e.g. `:99`, and `size` its geometry, e.g. `1280x720`. */
  constructor(
    private readonly display: string,
    private size: string,
    private readonly onFrame: (frame: ScreenFrame) => void,
  ) {}

  /**
   * Grab a screen of a different size from here on.
   *
   * `x11grab` takes its size when it opens the display and holds it, and an encoder holds
   * the size of the pictures it is making, so a screen that resized needs both again. The
   * old process is dropped before it is killed, so its exit reads as this one's doing
   * rather than as the capture dying.
   */
  resize(size: string): void {
    if (this.size === size || this.stopped) return;
    this.size = size;
    const old = this.proc;
    this.proc = null;
    // Half a picture of the old size belongs to the encoder being replaced, and the page
    // has to be told the new one's name before it can decode anything from it.
    this.pending = Buffer.alloc(0);
    this.announced = false;
    if (old && old.exitCode === null) {
      try {
        old.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    }
    this.spawn();
  }

  start(): void {
    this.firstFrameTimer = setTimeout(
      () => this.fail(`no frame within ${FIRST_FRAME_TIMEOUT_MS}ms`),
      FIRST_FRAME_TIMEOUT_MS,
    );
    this.firstFrameTimer.unref?.();
    this.spawn();
  }

  private spawn(): void {
    const proc = spawn(
      'ffmpeg',
      [
        '-loglevel', 'error',
        '-f', 'x11grab',
        '-framerate', String(FRAMES_PER_SECOND),
        '-video_size', this.size,
        '-i', this.display,
        '-c:v', 'libx264',
        '-preset', PRESET,
        // No frame waits for a later one, which is what a stream watched as it is made
        // needs; it also turns off the lookahead that would hold pictures back.
        '-tune', 'zerolatency',
        '-crf', String(QUALITY),
        '-pix_fmt', 'yuv420p',
        '-g', String(KEYFRAME_INTERVAL),
        // The delimiter in front of each picture, which is how they are told apart here.
        '-x264-params', 'aud=1',
        '-f', 'h264',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    proc.stdout?.on('data', (chunk: Buffer) => this.consume(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) logger.warn(`[VoiceChat:Display] ${line}`);
    });
    proc.on('error', (err) => this.fail(`could not start ffmpeg: ${err.message}`));
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.fail(`ffmpeg exited (${signal ?? code})`);
    });
    this.proc = proc;
  }

  /** Split the byte stream into whole pictures and hand each one on. */
  private consume(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const { units, rest } = splitAccessUnits(this.pending);
    this.pending = rest;
    for (const unit of units) {
      if (this.framesSeen === 0) this.clearFirstFrameTimer();
      this.framesSeen += 1;
      if (!this.announced) {
        const codec = codecFrom(unit);
        // The first picture carries the parameter sets, so this is where the name is.
        if (!codec) continue;
        this.announced = true;
        this.onFrame({ kind: 'start', encoding: 'h264', codec });
      }
      this.onFrame({ kind: 'h264', data: unit, keyframe: isKeyframe(unit) });
    }
  }

  /** A capture that died or never showed a frame. Logged, since the page has no other source. */
  private fail(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearFirstFrameTimer();
    logger.error(
      `[VoiceChat] Display capture ${this.framesSeen > 0 ? 'stopped' : 'never produced a frame'}: ${reason}`,
    );
  }

  private clearFirstFrameTimer(): void {
    if (this.firstFrameTimer) clearTimeout(this.firstFrameTimer);
    this.firstFrameTimer = null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearFirstFrameTimer();
    const proc = this.proc;
    this.proc = null;
    this.pending = Buffer.alloc(0);
    if (!proc || proc.exitCode !== null) return;
    try {
      proc.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
}
