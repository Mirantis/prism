import { describe, expect, it } from 'vitest';
import { decodeImage } from './decode-image.js';

// Two by two: red, green / blue, white. Written by ffmpeg and cwebp.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAFUlEQVR4nGP8z8DA+J+BhZHhP5AFAB0rBASFmh0FAAAAAElFTkSuQmCC';
const WEBP = 'UklGRiwAAABXRUJQVlA4TB8AAAAvAUAAAB8gEEjeHzqN+RcQFPwf3fxHZA/gBgwR/Q8BAA==';
const GIF =
  'R0lGODlhAgACAPcfAAAAAAAAVQAAqgAA/wAkAAAkVQAkqgAk/wBIAABIVQBIqgBI/wBsAABsVQBsqgBs/wCQAACQVQCQqgCQ/wC0AAC0VQC0qgC0/wDYAADYVQDYqgDY/wD8AAD8VQD8qgD8/yQAACQAVSQAqiQA/yQkACQkVSQkqiQk/yRIACRIVSRIqiRI/yRsACRsVSRsqiRs/ySQACSQVSSQqiSQ/yS0ACS0VSS0qiS0/yTYACTYVSTYqiTY/yT8ACT8VST8qiT8/0gAAEgAVUgAqkgA/0gkAEgkVUgkqkgk/0hIAEhIVUhIqkhI/0hsAEhsVUhsqkhs/0iQAEiQVUiQqkiQ/0i0AEi0VUi0qki0/0jYAEjYVUjYqkjY/0j8AEj8VUj8qkj8/2wAAGwAVWwAqmwA/2wkAGwkVWwkqmwk/2xIAGxIVWxIqmxI/2xsAGxsVWxsqmxs/2yQAGyQVWyQqmyQ/2y0AGy0VWy0qmy0/2zYAGzYVWzYqmzY/2z8AGz8VWz8qmz8/5AAAJAAVZAAqpAA/5AkAJAkVZAkqpAk/5BIAJBIVZBIqpBI/5BsAJBsVZBsqpBs/5CQAJCQVZCQqpCQ/5C0AJC0VZC0qpC0/5DYAJDYVZDYqpDY/5D8AJD8VZD8qpD8/7QAALQAVbQAqrQA/7QkALQkVbQkqrQk/7RIALRIVbRIqrRI/7RsALRsVbRsqrRs/7SQALSQVbSQqrSQ/7S0ALS0VbS0qrS0/7TYALTYVbTYqrTY/7T8ALT8VbT8qrT8/9gAANgAVdgAqtgA/9gkANgkVdgkqtgk/9hIANhIVdhIqthI/9hsANhsVdhsqths/9iQANiQVdiQqtiQ/9i0ANi0Vdi0qti0/9jYANjYVdjYqtjY/9j8ANj8Vdj8qtj8//wAAPwAVfwAqvwA//wkAPwkVfwkqvwk//xIAPxIVfxIqvxI//xsAPxsVfxsqvxs//yQAPyQVfyQqvyQ//y0APy0Vfy0qvy0//zYAPzYVfzYqvzY//z8APz8Vfz8qvz8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEBAAfACwAAAAAAgACAAAIBwDBcRjwLyAAOw==';
// Sixteen by sixteen, all red.
const JPEG =
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k=';

const QUAD = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255];

const bytes = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, 'base64'));

describe('decodeImage', () => {
  it.each([
    ['image/png', PNG],
    ['image/webp', WEBP],
  ])('decodes %s to RGBA pixels', async (mediaType, base64) => {
    const bitmap = await decodeImage(bytes(base64), mediaType);
    expect(bitmap.width).toBe(2);
    expect(bitmap.height).toBe(2);
    expect([...bitmap.data]).toEqual(QUAD);
  });

  it('decodes a GIF in the colors of its palette', async () => {
    const bitmap = await decodeImage(bytes(GIF), 'image/gif');
    expect([bitmap.width, bitmap.height]).toEqual([2, 2]);
    // ffmpeg's palette has 252 where the source had 255.
    expect([...bitmap.data]).toEqual([252, 0, 0, 255, 0, 252, 0, 255, 0, 0, 255, 255, 252, 252, 255, 255]);
  });

  it('decodes a JPEG', async () => {
    const bitmap = await decodeImage(bytes(JPEG), 'image/jpeg');
    expect([bitmap.width, bitmap.height]).toEqual([16, 16]);
    const [r, g, b, a] = bitmap.data;
    expect(r).toBeGreaterThan(240);
    expect(g).toBeLessThan(16);
    expect(b).toBeLessThan(16);
    expect(a).toBe(255);
  });

  it('refuses a type it has no decoder for', async () => {
    await expect(decodeImage(bytes(PNG), 'image/svg+xml')).rejects.toThrow('no decoder for image/svg+xml');
  });
});
