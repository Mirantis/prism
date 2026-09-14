/**
 * How big the agent's screen is, and how big the picture of it the model gets.
 *
 * The client decides the screen: the page sends the size of the rectangle it shows it in,
 * in its own device pixels, so the picture arrives at the size it is drawn and nothing is
 * scaled on the way. Changing the browser window or going fullscreen sends a new size and
 * the screen follows.
 *
 * Two bounds are not the client's to choose. The display cannot grow past the size its X
 * server was started at, since the framebuffer is allocated once, so `MAX_SCREEN` is what
 * that server reserves and anything larger is clamped to it. And the model's picture is
 * capped separately by `PICTURE_MAX_WIDTH`, because it is billed by the pixel on every
 * screenshot: a screen twice the size would double the cost of every look at it without
 * the model reading anything it could not read before.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

const COMMAND_TIMEOUT_MS = 10_000;

/**
 * How long a resize keeps trying.
 *
 * The desktop is spawned rather than waited for, so the first resize of a session can
 * arrive before the display manager that has to move the output aside for it. Once that
 * is up a resize takes on the first attempt, so this is a startup window rather than a
 * cost paid per change.
 */
const RESIZE_TIMEOUT_MS = 10_000;
const RESIZE_RETRY_MS = 250;
/**
 * How long the new size has to hold before the display counts as resized.
 *
 * The desktop applies its own display settings a moment after its session starts, which
 * puts back the size the X server was started at. A resize that lands in that moment
 * reads back correctly and is undone right after, so the size is read twice.
 */
const RESIZE_HOLD_MS = 1_500;

export interface ScreenSize {
  width: number;
  height: number;
}

/**
 * The largest screen a client may ask for, and what the X server reserves.
 *
 * A framebuffer this size costs about 8 MB, which is why the reservation is made once
 * rather than sized to the first client. Past it a client is served the maximum, which is
 * a screen smaller than its rectangle and a picture scaled up to fit. A page on a dense
 * display is past it, and what it gets is a desktop drawn at a comfortable size and blown
 * up, rather than a sharp one with everything on it half the size to look at.
 */
export const MAX_SCREEN: ScreenSize = { width: 1920, height: 1080 };

/** Below this a desktop has no room for a window, and a client this small is a mistake. */
export const MIN_SCREEN: ScreenSize = { width: 640, height: 360 };

/** What the screen is until a client says otherwise. */
export const DEFAULT_SCREEN: ScreenSize = { width: 1280, height: 720 };

/**
 * The widest picture the model is given, whatever the screen is.
 *
 * Its coordinates are in this picture and `DesktopControl` maps them back, so a bigger
 * screen costs the model nothing and loses it nothing it was reading anyway.
 */
export const PICTURE_MAX_WIDTH = 1280;

/** How much the grab is enlarged for OCR; see `screen-text.ts`. */
export const OCR_SCALE = 2;

/** Even numbers, since a JPEG's chroma is stored for each pair of pixels. */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** A size a client asked for, brought inside the bounds the display can serve. */
export function clampScreen(width: number, height: number): ScreenSize {
  const w = Number.isFinite(width) ? width : DEFAULT_SCREEN.width;
  const h = Number.isFinite(height) ? height : DEFAULT_SCREEN.height;
  return {
    width: even(Math.min(MAX_SCREEN.width, Math.max(MIN_SCREEN.width, w))),
    height: even(Math.min(MAX_SCREEN.height, Math.max(MIN_SCREEN.height, h))),
  };
}

/**
 * The model's picture of a screen this size: the screen itself while it is small enough,
 * and otherwise scaled down to the cap with its shape kept.
 *
 * The shape is kept so that what the model sees is what is there. Coordinates would map
 * back correctly from a stretched picture too, since each axis is scaled on its own, but
 * a stretched screen is a worse thing to read.
 */
export function pictureFor(screen: ScreenSize): ScreenSize {
  if (screen.width <= PICTURE_MAX_WIDTH) return { ...screen };
  const scale = PICTURE_MAX_WIDTH / screen.width;
  return { width: PICTURE_MAX_WIDTH, height: even(screen.height * scale) };
}

export function sameSize(a: ScreenSize, b: ScreenSize): boolean {
  return a.width === b.width && a.height === b.height;
}

export function sizeText(size: ScreenSize): string {
  return `${size.width}x${size.height}`;
}

/** The size the display is right now, or null where it cannot be read. */
export async function currentScreen(env: Record<string, string>): Promise<ScreenSize | null> {
  const { stdout } = await run('xrandr', ['-q'], {
    env: { ...process.env, ...env },
    timeout: COMMAND_TIMEOUT_MS,
  });
  const found = /current\s+(\d+)\s*x\s*(\d+)/.exec(stdout);
  return found ? { width: Number(found[1]), height: Number(found[2]) } : null;
}

/**
 * Resize the display's framebuffer.
 *
 * The X server reserves `MAX_SCREEN` at startup and this crops it, which is the one way a
 * running display changes size: its single output has one mode and no others can be added.
 * The desktop and the windows on it follow, since both watch for the change.
 *
 * **A desktop has to be running.** Shrinking the screen below the output's own mode needs
 * the output moved out of the way first, and it is the desktop's display manager that
 * does that when it sees the attempt. On a bare display the same command fails and changes
 * nothing. The same manager puts the size back once, as its session finishes starting,
 * which is why the size has to hold rather than merely arrive.
 *
 * The result is read back rather than taken from the exit status, because the two
 * disagree: `xrandr` reports the state it passed through — the output no longer fitting
 * the screen it sits on — as an error, and carries on to a screen that is the size asked
 * for. There is nothing to do about the complaint, since the output has exactly one mode
 * and no smaller one to be put into.
 */
export async function resizeDisplay(
  env: Record<string, string>,
  size: ScreenSize,
  timeoutMs = RESIZE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let now: ScreenSize | null = null;
  for (;;) {
    await run('xrandr', ['--fb', sizeText(size)], {
      env: { ...process.env, ...env },
      timeout: COMMAND_TIMEOUT_MS,
    }).catch(() => undefined);

    now = await currentScreen(env).catch(() => null);
    if (now && sameSize(now, size)) {
      await new Promise((resolve) => setTimeout(resolve, RESIZE_HOLD_MS));
      now = await currentScreen(env).catch(() => null);
      if (now && sameSize(now, size)) return;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, RESIZE_RETRY_MS));
  }
  throw new Error(
    `the display did not become ${sizeText(size)}${now ? `; it is ${sizeText(now)}` : ''}`,
  );
}
