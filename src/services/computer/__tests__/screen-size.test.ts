/**
 * How big the agent's screen is allowed to be, and how big the model's picture of it is.
 *
 * Two rules that a client cannot be trusted with: the display cannot grow past what its X
 * server reserved, and the model's picture is billed by the pixel on every screenshot.
 */

import { describe, it, expect } from 'vitest';
import {
  clampScreen,
  pictureFor,
  sizeText,
  MAX_SCREEN,
  MIN_SCREEN,
  PICTURE_MAX_WIDTH,
} from '../screen-size';

describe('clampScreen', () => {
  it('takes a size the display can serve as it is', () => {
    expect(clampScreen(1600, 900)).toEqual({ width: 1600, height: 900 });
  });

  it('holds a client to what the X server reserved', () => {
    // The framebuffer is allocated once, so anything past it is a size the display
    // cannot become however the client asks.
    expect(clampScreen(5000, 3000)).toEqual(MAX_SCREEN);
  });

  it('holds a client up to a screen with room for a window', () => {
    expect(clampScreen(10, 10)).toEqual(MIN_SCREEN);
  });

  it('rounds to whole pairs of pixels', () => {
    // A JPEG stores its colour for each pair, and an odd size costs a scaler on every
    // frame to no purpose.
    expect(clampScreen(1001, 563)).toEqual({ width: 1002, height: 564 });
  });

  it('falls back on a size that is not a number', () => {
    expect(clampScreen(Number.NaN, 720)).toEqual({ width: 1280, height: 720 });
  });
});

describe('pictureFor', () => {
  it('gives the model the screen itself while it is small enough', () => {
    expect(pictureFor({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
    expect(pictureFor({ width: 1024, height: 640 })).toEqual({ width: 1024, height: 640 });
  });

  it('caps a larger screen without changing its shape', () => {
    // Every screenshot is billed by the pixel, and a screen twice the size reads no
    // better. The shape is kept so the model is not reading a stretched desktop.
    const picture = pictureFor({ width: 1920, height: 1080 });
    expect(picture.width).toBe(PICTURE_MAX_WIDTH);
    expect(picture.height).toBe(720);
  });

  it('keeps the shape of a screen that is not sixteen by nine', () => {
    const picture = pictureFor({ width: 1920, height: 1200 });
    expect(picture.width).toBe(PICTURE_MAX_WIDTH);
    expect(picture.height).toBe(800);
  });
});

describe('sizeText', () => {
  it('formats dimensions for ffmpeg', () => {
    expect(sizeText({ width: 1280, height: 720 })).toBe('1280x720');
  });
});
