/** Decoded pixels, four bytes per pixel in RGBA order, rows top to bottom. */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Scale to `width` × `height` by averaging every source pixel a target pixel
 * covers, so a large picture keeps its detail at a few dozen cells. Color is
 * weighted by alpha, so a transparent pixel adds no color to its neighbours.
 */
export function resizeBitmap(source: Bitmap, width: number, height: number): Bitmap {
  if (source.width === width && source.height === height) return source;
  const data = new Uint8Array(width * height * 4);
  const xScale = source.width / width;
  const yScale = source.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yScale);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yScale));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xScale);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xScale));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        let at = (sy * source.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, at += 4) {
          const alpha = source.data[at + 3]!;
          r += source.data[at]! * alpha;
          g += source.data[at + 1]! * alpha;
          b += source.data[at + 2]! * alpha;
          a += alpha;
          count++;
        }
      }
      const out = (y * width + x) * 4;
      if (a > 0) {
        data[out] = Math.round(r / a);
        data[out + 1] = Math.round(g / a);
        data[out + 2] = Math.round(b / a);
      }
      data[out + 3] = Math.round(a / count);
    }
  }
  return { width, height, data };
}
