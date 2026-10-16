export interface ScreenSize {
  width: number;
  height: number;
}

/** Bounds for desktop dimensions supplied internally. */
export const MAX_SCREEN: ScreenSize = { width: 1920, height: 1080 };

/** Below this a desktop has no room for a window, and a client this small is a mistake. */
export const MIN_SCREEN: ScreenSize = { width: 640, height: 360 };

/** The persistent desktop size. */
export const DEFAULT_SCREEN: ScreenSize = { width: 1920, height: 1080 };

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

/** The most pixels a picture of a remote display has; a vision model shrinks a larger one. */
const PICTURE_MAX_PIXELS = 1280 * 900;

/**
 * The model's picture of a remote display, which can be any shape: its long edge at most
 * `PICTURE_MAX_WIDTH` and its area at most `PICTURE_MAX_PIXELS`, with its shape kept.
 */
export function boundedPictureFor(screen: ScreenSize): ScreenSize {
  const scale = Math.min(
    1,
    PICTURE_MAX_WIDTH / Math.max(screen.width, screen.height),
    Math.sqrt(PICTURE_MAX_PIXELS / (screen.width * screen.height)),
  );
  return { width: even(screen.width * scale), height: even(screen.height * scale) };
}

export function sizeText(size: ScreenSize): string {
  return `${size.width}x${size.height}`;
}
