/**
 * The whole virtual display as a picture stream for the page.
 *
 * `ffmpeg` grabs the X display at a fixed rate and writes one JPEG after another to
 * its stdout; this splits them on the JPEG end marker and hands each one on. Used
 * where the runtime owns the display, so the page sees the desktop and not one tab.
 * The end marker is safe to split on: inside a JPEG's entropy-coded data every 0xFF is
 * followed by 0x00 or a restart marker, never by 0xD9.
 */

import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../../logger';
import type { PictureStream } from './picture-stream';

const FRAMES_PER_SECOND = 10;
/** ffmpeg's MJPEG quality scale: 2 is best, 31 worst. */
const FRAME_QUALITY = 7;
const JPEG_END_MARKER = Buffer.from([0xff, 0xd9]);
/** A capture that has shown nothing by now is not going to; say so in the log. */
const FIRST_FRAME_TIMEOUT_MS = 5_000;

export class DisplayStream implements PictureStream {
  private proc: ChildProcess | null = null;
  private pending: Buffer = Buffer.alloc(0);
  private framesSent = 0;
  private firstFrameTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  /**
   * `display` is the X display, e.g. `:99`, and `size` its geometry, e.g. `1280x720`.
   * Frames reach `onFrame` as base64 JPEG.
   */
  constructor(
    private readonly display: string,
    private readonly size: string,
    private readonly onFrame: (jpegBase64: string) => void,
  ) {}

  start(): void {
    this.firstFrameTimer = setTimeout(
      () => this.fail(`no frame within ${FIRST_FRAME_TIMEOUT_MS}ms`),
      FIRST_FRAME_TIMEOUT_MS,
    );
    this.firstFrameTimer.unref?.();
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

  /** Split the byte stream into whole JPEGs and hand each one on. */
  private consume(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    let end = this.pending.indexOf(JPEG_END_MARKER);
    while (end !== -1) {
      const frame = this.pending.subarray(0, end + JPEG_END_MARKER.length);
      this.pending = this.pending.subarray(end + JPEG_END_MARKER.length);
      if (this.framesSent === 0) this.clearFirstFrameTimer();
      this.framesSent += 1;
      this.onFrame(frame.toString('base64'));
      end = this.pending.indexOf(JPEG_END_MARKER);
    }
  }

  /** A capture that died or never showed a frame. Logged, since the page has no other source. */
  private fail(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearFirstFrameTimer();
    logger.error(
      `[VoiceChat] Display capture ${this.framesSent > 0 ? 'stopped' : 'never produced a frame'}: ${reason}`,
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
