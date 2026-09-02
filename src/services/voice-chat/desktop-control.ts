/**
 * Mouse, keyboard and a camera for the virtual display: `xdotool` for the first two,
 * one `ffmpeg` grab for the third.
 *
 * Coordinates are pixels on the display, the same ones the model reads off the picture
 * `capture()` returns, so what it sees is what it clicks.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

export type MouseButton = 'left' | 'middle' | 'right';
export type ScrollDirection = 'up' | 'down';

/** X11 button numbers: 1 left, 2 middle, 3 right, 4 wheel up, 5 wheel down. */
const BUTTONS: Record<MouseButton, string> = { left: '1', middle: '2', right: '3' };
const WHEEL: Record<ScrollDirection, string> = { up: '4', down: '5' };

/** A key name or chord for `xdotool key`: `Return`, `ctrl+l`, `alt+F4`, `super`. */
const KEY_CHORD = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/;

const COMMAND_TIMEOUT_MS = 10_000;
/** JPEG quality for the model's picture on ffmpeg's scale, where 2 is best and 31 worst. */
const CAPTURE_QUALITY = 6;
const CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

export class DesktopControl {
  readonly width: number;
  readonly height: number;

  /** `env` is the display's: DISPLAY and XDG_RUNTIME_DIR. `size` is its geometry, e.g. `1280x720`. */
  constructor(
    private readonly env: Record<string, string>,
    private readonly size: string,
  ) {
    const [w, h] = size.split('x').map(Number);
    this.width = w;
    this.height = h;
  }

  async click(x: number, y: number, button: MouseButton = 'left', count = 1): Promise<void> {
    const [px, py] = this.clamp(x, y);
    await this.xdotool([
      'mousemove', '--sync', String(px), String(py),
      'click', '--repeat', String(count), '--delay', '80', BUTTONS[button],
    ]);
  }

  async type(text: string): Promise<void> {
    await this.xdotool(['type', '--clearmodifiers', '--delay', '15', '--', text]);
  }

  async key(chord: string): Promise<void> {
    if (!KEY_CHORD.test(chord)) throw new Error(`"${chord}" is not a key name or chord`);
    await this.xdotool(['key', '--clearmodifiers', '--', chord]);
  }

  async scroll(x: number, y: number, direction: ScrollDirection, clicks = 3): Promise<void> {
    const [px, py] = this.clamp(x, y);
    await this.xdotool([
      'mousemove', '--sync', String(px), String(py),
      'click', '--repeat', String(clicks), '--delay', '40', WHEEL[direction],
    ]);
  }

  /** One JPEG of the whole display. */
  async capture(): Promise<Buffer> {
    const { stdout } = await run(
      'ffmpeg',
      [
        '-loglevel', 'error',
        '-f', 'x11grab', '-video_size', this.size, '-i', this.env.DISPLAY,
        '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', String(CAPTURE_QUALITY),
        '-',
      ],
      { env: this.processEnv(), encoding: 'buffer', maxBuffer: CAPTURE_MAX_BYTES, timeout: COMMAND_TIMEOUT_MS },
    );
    return stdout as Buffer;
  }

  private clamp(x: number, y: number): [number, number] {
    const px = Math.min(this.width - 1, Math.max(0, Math.round(x)));
    const py = Math.min(this.height - 1, Math.max(0, Math.round(y)));
    return [px, py];
  }

  private async xdotool(args: string[]): Promise<void> {
    await run('xdotool', args, { env: this.processEnv(), timeout: COMMAND_TIMEOUT_MS });
  }

  private processEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.env };
  }
}
