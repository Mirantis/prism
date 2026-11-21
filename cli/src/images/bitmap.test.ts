import { describe, expect, it } from 'vitest';
import { resizeBitmap } from './bitmap.js';

describe('resizeBitmap', () => {
  it('averages the pixels a target pixel covers', () => {
    const source = { width: 2, height: 1, data: new Uint8Array([200, 0, 0, 255, 0, 100, 0, 255]) };
    expect([...resizeBitmap(source, 1, 1).data]).toEqual([100, 50, 0, 255]);
  });

  it('takes no color from a transparent pixel', () => {
    const source = { width: 2, height: 1, data: new Uint8Array([200, 0, 0, 255, 0, 0, 255, 0]) };
    expect([...resizeBitmap(source, 1, 1).data]).toEqual([200, 0, 0, 128]);
  });

  it('repeats pixels when it enlarges', () => {
    const source = { width: 1, height: 1, data: new Uint8Array([1, 2, 3, 4]) };
    expect([...resizeBitmap(source, 2, 1).data]).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });
});
