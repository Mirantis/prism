/**
 * A source of JPEG pictures of what the agent is looking at, for the page.
 *
 * Two implementations: the tab in front over CDP where the browser runs on the host's
 * own display, and the whole virtual display through ffmpeg where the runtime owns it.
 */
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
