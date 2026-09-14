/**
 * A source of what the agent is looking at, for the page.
 *
 * Two implementations, and they differ in what they can produce. Where the runtime owns
 * the display it encodes the whole screen as video, because a desktop that changes in one
 * corner costs almost nothing that way. Where the browser runs on the host's own display
 * the source is Chromium's debugger, which hands over one picture at a time.
 */

/**
 * What a source hands the page.
 *
 * `start` comes once before any picture and says how the ones after it are encoded, so the
 * page knows what to decode before the first byte of it arrives. It comes again whenever
 * the source restarts, since a video stream that starts over is a new stream.
 */
export type ScreenFrame =
  | { kind: 'start'; encoding: 'jpeg' }
  | { kind: 'start'; encoding: 'h264'; codec: string }
  | { kind: 'jpeg'; data: string }
  | { kind: 'h264'; data: Buffer; keyframe: boolean };

export interface PictureStream {
  start(): void;
  /**
   * Send pictures of this size from here on, where the source has a size of its own.
   *
   * The tab source has none: it sends the tab at whatever size the browser draws it.
   */
  resize?(size: string): void;
  stop(): Promise<void>;
}
