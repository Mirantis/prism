/**
 * A source of JPEG pictures of what the agent is looking at, for the page.
 *
 * Two implementations: the tab in front over CDP where the browser runs on the host's
 * own display, and the whole virtual display through ffmpeg where the runtime owns it.
 */
export interface PictureStream {
  start(): void;
  stop(): Promise<void>;
}
