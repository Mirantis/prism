/**
 * The agent's browser as a picture stream for the page: the tab in front, captured by
 * Chromium's own screencast over CDP and handed on as JPEG frames.
 *
 * A screencast is per tab, so this follows `front()` on a timer and moves the capture
 * when `browse` opens or switches a tab. Frames are rate-limited: they share the socket
 * and the CPU with the audio. The newest frame is never dropped for good, only delayed
 * to the next slot, so a page that stops changing is shown as it ended up.
 */

import type { CDPSession, Page } from 'playwright-core';
import { logger } from '../../logger';

/** How often to check which tab is in front. */
const FOLLOW_INTERVAL_MS = 1000;
/** Least time between two frames sent to the page: ten a second at most. */
const MIN_FRAME_GAP_MS = 100;
/**
 * Capture every third compositor frame. Chromium encodes a JPEG for each frame it
 * captures, and a playing video produces 30 to 60 a second; in a container with no
 * GPU that encoding competes with the audio for the CPU, and the page shows ten a
 * second at most anyway.
 */
const CAPTURE_EVERY_NTH_FRAME = 3;
const FRAME_QUALITY = 50;
const FRAME_MAX_WIDTH = 1024;
const FRAME_MAX_HEIGHT = 576;

export class ScreenStream {
  private session: CDPSession | null = null;
  private page: Page | null = null;
  private followTimer: NodeJS.Timeout | null = null;
  private following = false;
  private lastFrameAt = 0;
  private pending: string | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly front: () => Page | null,
    private readonly onFrame: (jpegBase64: string) => void,
  ) {}

  start(): void {
    this.followTimer = setInterval(() => void this.follow(), FOLLOW_INTERVAL_MS);
    this.followTimer.unref?.();
    void this.follow();
  }

  /** Point the capture at the tab in front, when that changed or the old one closed. */
  private async follow(): Promise<void> {
    if (this.stopped || this.following) return;
    const page = this.front();
    if (page === this.page && page !== null && !page.isClosed()) return;

    this.following = true;
    try {
      await this.detach();
      if (!page || page.isClosed()) return;

      const session = await page.context().newCDPSession(page);
      session.on('Page.screencastFrame', (frame) => {
        void session
          .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
          .catch(() => undefined);
        this.offer(frame.data);
      });
      await session.send('Page.startScreencast', {
        format: 'jpeg',
        quality: FRAME_QUALITY,
        maxWidth: FRAME_MAX_WIDTH,
        maxHeight: FRAME_MAX_HEIGHT,
        everyNthFrame: CAPTURE_EVERY_NTH_FRAME,
      });
      this.session = session;
      this.page = page;
      // The screencast only sends a frame when the page repaints, and a page that has
      // finished loading may not repaint for a long time. One screenshot shows it now.
      const shot = await page.screenshot({ type: 'jpeg', quality: FRAME_QUALITY, timeout: 5_000 });
      this.offer(shot.toString('base64'));
    } catch (err) {
      logger.warn({ err }, '[VoiceChat] Could not start the screen stream');
    } finally {
      this.following = false;
    }
  }

  /** Send a frame now if the slot is free, else keep the newest for the next slot. */
  private offer(data: string): void {
    if (this.stopped) return;
    const wait = MIN_FRAME_GAP_MS - (Date.now() - this.lastFrameAt);
    if (wait <= 0) {
      this.emit(data);
      return;
    }
    this.pending = data;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const next = this.pending;
      this.pending = null;
      if (next !== null) this.emit(next);
    }, wait);
  }

  private emit(data: string): void {
    this.lastFrameAt = Date.now();
    this.onFrame(data);
  }

  private async detach(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.page = null;
    if (!session) return;
    await session.send('Page.stopScreencast').catch(() => undefined);
    await session.detach().catch(() => undefined);
  }

  /** Stop following and capturing. Safe to call more than once. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.followTimer) clearInterval(this.followTimer);
    this.followTimer = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending = null;
    await this.detach();
  }
}
