/**
 * Which pictures of a recording are worth keeping.
 *
 * A recording is sampled several times a second, and most of those samples show the same
 * screen as the one before. What the agent needs is the moments the screen changed, so a
 * sample is kept when it differs enough from the last one kept, and the kept list is held
 * to a ceiling by dropping whichever picture its neighbours already show.
 *
 * The comparison runs on a tiny grey copy of each frame rather than the picture itself:
 * a few hundred bytes to hold and to subtract, several times a second, for the whole
 * length of a recording.
 */

/** The width and height the comparison copy is drawn at. */
export const THUMB_WIDTH = 32;
export const THUMB_HEIGHT = 18;

/**
 * How different two samples must be to count as a change, as a fraction of the largest
 * difference two frames could have. Set low: a menu opening in one corner moves few
 * pixels, and a recording that misses it is worse than one with a near-duplicate in it.
 */
export const CHANGE_THRESHOLD = 0.012;

/** How many pictures reach the model. The runtime refuses more. */
export const MAX_FRAMES = 20;

/** A picture the page kept, with the offset into the recording it was taken at. */
export interface KeptFrame {
  /** Base64 JPEG, without the data-URI prefix. */
  data: string;
  /** Milliseconds from the start of the recording. */
  at: number;
  /** The grey copy this frame was judged by, kept to judge the next one against. */
  thumb: Uint8ClampedArray;
}

/**
 * How much two grey copies differ, from 0 (identical) to 1.
 *
 * Mean absolute difference rather than a count of changed pixels: a caret blinking in a
 * terminal changes a handful of pixels completely, and a window fading in changes all of
 * them a little. Averaging treats the second as the larger change, which it is.
 */
export function frameDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length === 0 || a.length !== b.length) return 1;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / (a.length * 255);
}

/** Whether a sample has changed enough from the last kept picture to keep as well. */
export function hasChanged(previous: Uint8ClampedArray | null, next: Uint8ClampedArray): boolean {
  if (!previous) return true;
  return frameDifference(previous, next) >= CHANGE_THRESHOLD;
}

/**
 * Bring a kept list back to `max` by dropping the one picture its neighbours make
 * redundant: of every frame with a picture on each side, the one whose neighbours are
 * most alike.
 *
 * The first and the last are never dropped. The first is where the recording started,
 * which is the only frame that shows what the screen looked like before anything happened,
 * and the last is where it ended, which is usually the result the user is asking about.
 */
export function capFrames(frames: KeptFrame[], max: number = MAX_FRAMES): KeptFrame[] {
  const kept = [...frames];
  while (kept.length > max && kept.length > 2) {
    let dropAt = 1;
    let smallest = Infinity;
    for (let i = 1; i < kept.length - 1; i++) {
      const spread = frameDifference(kept[i - 1].thumb, kept[i + 1].thumb);
      if (spread < smallest) {
        smallest = spread;
        dropAt = i;
      }
    }
    kept.splice(dropAt, 1);
  }
  return kept;
}
