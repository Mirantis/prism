/**
 * The two coordinate spaces: the screen in pixels, and the picture the model works in.
 *
 * They part company as soon as a client asks for a screen larger than the picture cap,
 * and every click the model makes goes through the mapping between them.
 */

import { describe, it, expect } from 'vitest';
import { DesktopControl } from '../desktop-control';

const env = { DISPLAY: ':99' };

describe('DesktopControl', () => {
  it('gives the model the screen itself while it is small enough', () => {
    const control = new DesktopControl(env, { width: 1280, height: 720 });

    expect(control.pictureWidth).toBe(1280);
    expect(control.pictureHeight).toBe(720);
    expect(control.toPicture(640, 360)).toEqual([640, 360]);
  });

  it('maps a point on a screen larger than the picture', () => {
    const control = new DesktopControl(env, { width: 1920, height: 1080 });

    expect(control.pictureWidth).toBe(1280);
    expect(control.pictureHeight).toBe(720);
    // The middle of the screen is the middle of the picture, whatever the scale.
    expect(control.toPicture(960, 540)).toEqual([640, 360]);
  });

  it('follows the screen when the client resizes it', () => {
    const control = new DesktopControl(env, { width: 1280, height: 720 });

    control.resize({ width: 1920, height: 1200 });

    expect(control.width).toBe(1920);
    expect(control.height).toBe(1200);
    // The cap holds, and the shape follows the new screen rather than the old one.
    expect(control.pictureWidth).toBe(1280);
    expect(control.pictureHeight).toBe(800);
    expect(control.toPicture(960, 600)).toEqual([640, 400]);
  });
});
