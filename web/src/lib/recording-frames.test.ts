import { describe, it, expect } from 'vitest';

/**
 * Choosing which pictures of a recording are worth keeping.
 *
 * Both halves matter to what the agent is shown. Judging a change too strictly loses the
 * moment the user is talking about; the cap is what keeps a busy screen from spending the
 * whole budget on the first ten seconds.
 */

import {
  capFrames,
  CHANGE_THRESHOLD,
  frameDifference,
  hasChanged,
  type KeptFrame,
} from './recording-frames';

/** A grey copy where every pixel has the same value. */
function flat(value: number, size = 16): Uint8ClampedArray {
  return new Uint8ClampedArray(size).fill(value);
}

/** A kept picture whose grey copy is `value` throughout. */
function frame(at: number, value: number): KeptFrame {
  return { data: `f${at}`, at, thumb: flat(value) };
}

describe('frameDifference', () => {
  it('is nothing for the same picture and everything for its opposite', () => {
    expect(frameDifference(flat(120), flat(120))).toBe(0);
    expect(frameDifference(flat(0), flat(255))).toBe(1);
  });

  it('grows with how much of the picture moved', () => {
    const small = frameDifference(flat(100), flat(103));
    const large = frameDifference(flat(100), flat(200));
    expect(small).toBeLessThan(large);
  });

  it('treats a copy of another size as a change', () => {
    expect(frameDifference(flat(100, 16), flat(100, 8))).toBe(1);
  });
});

describe('hasChanged', () => {
  it('keeps the first picture, having nothing to compare it with', () => {
    expect(hasChanged(null, flat(10))).toBe(true);
  });

  it('skips a screen that has not moved', () => {
    expect(hasChanged(flat(100), flat(100))).toBe(false);
  });

  it('keeps one that has', () => {
    const moved = flat(100 + Math.ceil(CHANGE_THRESHOLD * 255) + 1);
    expect(hasChanged(flat(100), moved)).toBe(true);
  });
});

describe('capFrames', () => {
  it('leaves a list already under the ceiling alone', () => {
    const frames = [frame(0, 10), frame(1, 200)];
    expect(capFrames(frames, 4)).toEqual(frames);
  });

  it('keeps the start and the end of the recording', () => {
    const frames = [frame(0, 0), frame(1, 10), frame(2, 20), frame(3, 250)];
    const kept = capFrames(frames, 2);

    expect(kept.map((f) => f.at)).toEqual([0, 3]);
  });

  it('drops the picture its neighbours already show', () => {
    // The middle of the first three is a step in a slow fade, so either side of it says
    // what it says. The last is a different screen entirely.
    const frames = [frame(0, 100), frame(1, 104), frame(2, 108), frame(3, 250)];

    expect(capFrames(frames, 3).map((f) => f.at)).toEqual([0, 2, 3]);
  });
});
