/**
 * What the agent's screen is drawn with, whichever way it arrives.
 *
 * The runtime sends the whole virtual display as video, because a desktop that changes in
 * one corner costs almost nothing that way. Where the agent's browser runs on a host's own
 * display there is no video to send: that source is the browser's own debugger, which
 * hands over one picture at a time. Both end up on the same canvas, so the page has one
 * thing to lay out and one thing to take the pointer on.
 */

/** The one canvas both paths draw into; it may not be mounted yet. */
type CanvasOf = () => HTMLCanvasElement | null;

function drawTo(canvas: HTMLCanvasElement, source: CanvasImageSource, width: number, height: number): void {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  canvas.getContext('2d')?.drawImage(source, 0, 0);
}

/** Whether this browser can decode video the runtime sends. */
export function canDecodeVideo(): boolean {
  return typeof VideoDecoder !== 'undefined';
}

export class ScreenCanvas {
  private decoder: VideoDecoder | null = null;
  /** Pictures are timed from the first one, since the runtime sends no clock. */
  private frames = 0;
  /**
   * True once a picture that stands on its own has arrived. A decoder started mid-stream
   * cannot read the ones between, and answers an error for each.
   */
  private started = false;
  /** The newest picture waiting to be drawn, so a slow draw skips rather than queues. */
  private latest: ImageBitmap | null = null;
  private drawing = false;
  private closed = false;

  private readonly canvas: CanvasOf;

  constructor(canvas: CanvasOf) {
    this.canvas = canvas;
  }

  /** Take video from here on, decoded as `codec` names it. */
  openVideo(codec: string): void {
    this.closeDecoder();
    if (this.closed || !canDecodeVideo()) return;
    this.frames = 0;
    this.started = false;
    const decoder = new VideoDecoder({
      output: (frame) => {
        const canvas = this.canvas();
        if (canvas) drawTo(canvas, frame, frame.displayWidth, frame.displayHeight);
        frame.close();
      },
      error: () => {
        // The stream is unreadable from here; the next one that stands on its own starts
        // it again.
        this.started = false;
      },
    });
    // No description, so the pictures are read as the stream the runtime writes them in.
    decoder.configure({ codec, optimizeForLatency: true });
    this.decoder = decoder;
  }

  /** Take pictures from here on. */
  openPictures(): void {
    this.closeDecoder();
  }

  /** One picture of the screen as video. */
  video(data: ArrayBuffer, keyframe: boolean): void {
    const decoder = this.decoder;
    if (!decoder || decoder.state !== 'configured') return;
    if (!this.started && !keyframe) return;
    this.started = true;
    decoder.decode(
      new EncodedVideoChunk({
        type: keyframe ? 'key' : 'delta',
        // Microseconds, and only their order matters: nothing waits on this clock.
        timestamp: (this.frames++ * 1e6) / 30,
        data,
      }),
    );
  }

  /** One picture of the screen as JPEG. */
  picture(base64: string): void {
    const blob = fetch(`data:image/jpeg;base64,${base64}`).then((r) => r.blob());
    void blob
      .then((b) => createImageBitmap(b))
      .then((bitmap) => {
        // A picture decoded after `close()` is of a screen this canvas no longer shows, and
        // the canvas element may already show another computer's.
        if (this.closed) {
          bitmap.close();
          return;
        }
        // Decoding is asynchronous, so an older picture can land after a newer one. Only
        // the newest is kept, and the rest are released.
        this.latest?.close();
        this.latest = bitmap;
        this.drawLatest();
      })
      .catch(() => undefined);
  }

  private drawLatest(): void {
    if (this.drawing) return;
    this.drawing = true;
    const bitmap = this.latest;
    this.latest = null;
    const canvas = this.canvas();
    if (bitmap && canvas) drawTo(canvas, bitmap, bitmap.width, bitmap.height);
    bitmap?.close();
    this.drawing = false;
    if (this.latest) this.drawLatest();
  }

  close(): void {
    this.closed = true;
    this.closeDecoder();
    this.latest?.close();
    this.latest = null;
  }

  private closeDecoder(): void {
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder && decoder.state !== 'closed') decoder.close();
  }
}
