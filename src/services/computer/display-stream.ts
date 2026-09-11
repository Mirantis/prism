/**
 * The whole virtual display as a picture stream for the page.
 *
 * `ffmpeg` grabs the X display at a fixed rate and writes one JPEG after another to
 * its stdout; this splits them on the JPEG end marker and hands each one on. Used
 * where the runtime owns the display, so the page sees the desktop and not one tab.
 * The end marker is safe to split on: inside a JPEG's entropy-coded data every 0xFF is
 * followed by 0x00 or a restart marker, never by 0xD9.
 *
 * A frame identical to the one before it is not sent. The grab knows nothing about
 * change, so a still desktop yields the same JPEG over and over; the display has no
 * noise and the encoder is deterministic, so unchanged pixels mean identical bytes, and
 * one comparison per frame makes an idle screen cost nothing.
 */

import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../../logger';
import type { PictureStream } from './picture-stream';

const FRAMES_PER_SECOND = 30;
/** ffmpeg's MJPEG quality scale: 2 is best, 31 worst. */
const FRAME_QUALITY = 7;
const JPEG_END_MARKER = Buffer.from([0xff, 0xd9]);
/** A capture that has shown nothing by now is not going to; say so in the log. */
const FIRST_FRAME_TIMEOUT_MS = 5_000;

export class DisplayStream implements PictureStream {
  private proc: ChildProcess | null = null;
  private pending: Buffer = Buffer.alloc(0);
  /** Frames the grab produced, sent or not. */
  private framesSeen = 0;
  /** The last frame sent, to hold back a repeat of it. */
  private lastSent: Buffer | null = null;
  private firstFrameTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  /**
   * `display` is the X display, e.g. `:99`, and `size` its geometry, e.g. `1280x720`.
   * Frames reach `onFrame` as base64 JPEG.
   */
  constructor(
    private readonly display: string,
    private size: string,
    private readonly onFrame: (jpegBase64: string) => void,
  ) {}

  /**
   * Grab a screen of a different size from here on.
   *
   * `x11grab` takes its size when it opens the display and holds it, so a screen that
   * resized needs a new grab: the old one goes on producing frames of the old size, which
   * the client draws into a box that is no longer that shape.
   *
   * The old process is dropped before it is killed, so its exit reads as this one's doing
   * rather than as the capture dying.
   */
  resize(size: string): void {
    if (this.size === size || this.stopped) return;
    this.size = size;
    const old = this.proc;
    this.proc = null;
    // A frame of the old size half-read, and a repeat check against a frame of a shape
    // that is gone: both belong to the grab being replaced.
    this.pending = Buffer.alloc(0);
    this.lastSent = null;
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
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', String(FRAME_QUALITY),
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

  /** Split the byte stream into whole JPEGs and hand on each one that differs from the last. */
  private consume(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    let end = this.pending.indexOf(JPEG_END_MARKER);
    while (end !== -1) {
      const frame = this.pending.subarray(0, end + JPEG_END_MARKER.length);
      this.pending = this.pending.subarray(end + JPEG_END_MARKER.length);
      end = this.pending.indexOf(JPEG_END_MARKER);
      if (this.framesSeen === 0) this.clearFirstFrameTimer();
      this.framesSeen += 1;
      if (this.lastSent?.equals(frame)) continue;
      this.lastSent = Buffer.from(frame);
      this.onFrame(frame.toString('base64'));
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
    this.lastSent = null;
    if (!proc || proc.exitCode !== null) return;
    try {
      proc.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
}
