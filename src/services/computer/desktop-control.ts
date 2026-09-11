/**
 * Mouse, keyboard and a camera for the virtual display: `xdotool` for the first two,
 * one `ffmpeg` grab for the third.
 *
 * The model works in the coordinates of the picture `capture()` returns: the screen, at
 * its own size or scaled down to the cap in `screen-size.ts`, and nothing drawn on it. A labelled
 * grid was tried as a ruler and measured against the truth; it made the model's vertical
 * estimates twenty to forty pixels worse, while on the plain picture they were within six.
 * `click()`, `move()`, `drag()` and `scroll()` take picture coordinates and map them to the
 * screen here, so the two never have to agree anywhere else.
 *
 * `mousemove` is never given `--sync`. That flag waits for the pointer to move, and when
 * the pointer is already where it is sent, which is the normal case after the model has
 * parked it there to check, the wait never ends and the command times out. The commands
 * in one call run in order without it.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { OCR_SCALE, pictureFor, sizeText, type ScreenSize } from './screen-size';

export { OCR_SCALE };

const run = promisify(execFile);

export type MouseButton = 'left' | 'middle' | 'right';
export type ScrollDirection = 'up' | 'down';

/** X11 button numbers: 1 left, 2 middle, 3 right, 4 wheel up, 5 wheel down. */
const BUTTONS: Record<MouseButton, string> = { left: '1', middle: '2', right: '3' };
const WHEEL: Record<ScrollDirection, string> = { up: '4', down: '5' };

/** A key name or chord for `xdotool key`: `Return`, `ctrl+l`, `alt+F4`, `super`. */
const KEY_CHORD = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/;

/**
 * Steps a drag is made of. Many programs only start a drag on motion after the press,
 * and a card or a window follows the pointer, so the path is walked rather than jumped.
 */
const DRAG_STEPS = 8;

const COMMAND_TIMEOUT_MS = 10_000;
/** JPEG quality for the model's picture on ffmpeg's scale, where 2 is best and 31 worst. */
const CAPTURE_QUALITY = 6;
const CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

export class DesktopControl {
  /** The screen's size in pixels, which the client changes as its own window changes. */
  private screen: ScreenSize;
  /** The model's picture, which its coordinates refer to. */
  private picture: ScreenSize;

  /** `env` is the display's: DISPLAY and XDG_RUNTIME_DIR. `screen` is its size in pixels. */
  constructor(
    private readonly env: Record<string, string>,
    screen: ScreenSize,
  ) {
    this.screen = { ...screen };
    this.picture = pictureFor(screen);
  }

  get width(): number {
    return this.screen.width;
  }

  get height(): number {
    return this.screen.height;
  }

  get pictureWidth(): number {
    return this.picture.width;
  }

  get pictureHeight(): number {
    return this.picture.height;
  }

  /**
   * Follow the screen to a new size.
   *
   * The display itself is resized by the computer that owns it; this is the record of it,
   * and the coordinate mapping below is what has to agree with the pixels a grab returns.
   */
  resize(screen: ScreenSize): void {
    this.screen = { ...screen };
    this.picture = pictureFor(screen);
  }

  /** Put the pointer on a point given in picture coordinates, without clicking. */
  async move(x: number, y: number): Promise<void> {
    const [px, py] = this.toScreen(x, y);
    await this.xdotool(['mousemove', String(px), String(py)]);
  }

  /** Click at a point given in picture coordinates, or where the pointer is when none is given. */
  async click(
    at: { x: number; y: number } | null,
    button: MouseButton = 'left',
    count = 1,
  ): Promise<void> {
    const move = at ? ['mousemove', ...this.toScreen(at.x, at.y).map(String)] : [];
    await this.xdotool([
      ...move,
      'click', '--repeat', String(count), '--delay', '80', BUTTONS[button],
    ]);
  }

  /**
   * Press at one point, move to another, release, all in picture coordinates. One
   * `xdotool` call carries the whole sequence, with `sleep`s between the steps.
   */
  async drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    button: MouseButton = 'left',
  ): Promise<void> {
    const [x0, y0] = this.toScreen(from.x, from.y);
    const [x1, y1] = this.toScreen(to.x, to.y);
    const args = ['mousemove', String(x0), String(y0), 'mousedown', BUTTONS[button], 'sleep', '0.1'];
    for (let step = 1; step <= DRAG_STEPS; step++) {
      const x = Math.round(x0 + ((x1 - x0) * step) / DRAG_STEPS);
      const y = Math.round(y0 + ((y1 - y0) * step) / DRAG_STEPS);
      args.push('mousemove', String(x), String(y), 'sleep', '0.03');
    }
    args.push('sleep', '0.1', 'mouseup', BUTTONS[button]);
    await this.xdotool(args);
  }

  async type(text: string): Promise<void> {
    await this.xdotool(['type', '--clearmodifiers', '--delay', '15', '--', text]);
  }

  async key(chord: string): Promise<void> {
    if (!KEY_CHORD.test(chord)) throw new Error(`"${chord}" is not a key name or chord`);
    await this.xdotool(['key', '--clearmodifiers', '--', chord]);
  }

  /** Scroll the wheel over a point given in picture coordinates. */
  async scroll(x: number, y: number, direction: ScrollDirection, clicks = 3): Promise<void> {
    const [px, py] = this.toScreen(x, y);
    await this.xdotool([
      'mousemove', String(px), String(py),
      'click', '--repeat', String(clicks), '--delay', '40', WHEEL[direction],
    ]);
  }

  /** The model's picture: the whole display at the picture size. */
  async capture(): Promise<Buffer> {
    const { stdout } = await run(
      'ffmpeg',
      [
        '-loglevel', 'error',
        '-f', 'x11grab', '-video_size', sizeText(this.screen), '-i', this.env.DISPLAY,
        '-frames:v', '1', '-vf', `scale=${this.picture.width}:${this.picture.height}`,
        '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', String(CAPTURE_QUALITY),
        '-',
      ],
      { env: this.processEnv(), encoding: 'buffer', maxBuffer: CAPTURE_MAX_BYTES, timeout: COMMAND_TIMEOUT_MS },
    );
    return stdout as Buffer;
  }

  /** A lossless PNG of the display enlarged `OCR_SCALE` times, for Tesseract. */
  async captureForOcr(): Promise<Buffer> {
    const { stdout } = await run(
      'ffmpeg',
      [
        '-loglevel', 'error',
        '-f', 'x11grab', '-video_size', sizeText(this.screen), '-i', this.env.DISPLAY,
        '-frames:v', '1', '-vf', `scale=iw*${OCR_SCALE}:ih*${OCR_SCALE}`,
        '-f', 'image2pipe', '-vcodec', 'png', '-',
      ],
      { env: this.processEnv(), encoding: 'buffer', maxBuffer: CAPTURE_MAX_BYTES * 4, timeout: COMMAND_TIMEOUT_MS },
    );
    return stdout as Buffer;
  }

  /** A screen pixel as a picture coordinate, the inverse of `toScreen`. */
  toPicture(x: number, y: number): [number, number] {
    return [(x * this.picture.width) / this.screen.width, (y * this.picture.height) / this.screen.height];
  }

  /** A picture coordinate as a screen pixel, kept on the screen. */
  private toScreen(x: number, y: number): [number, number] {
    const sx = (x * this.screen.width) / this.picture.width;
    const sy = (y * this.screen.height) / this.picture.height;
    const px = Math.min(this.screen.width - 1, Math.max(0, Math.round(sx)));
    const py = Math.min(this.screen.height - 1, Math.max(0, Math.round(sy)));
    return [px, py];
  }

  private async xdotool(args: string[]): Promise<void> {
    await run('xdotool', args, { env: this.processEnv(), timeout: COMMAND_TIMEOUT_MS });
  }

  private processEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.env };
  }
}
