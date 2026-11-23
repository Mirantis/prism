import jpeg from 'jpeg-js';
import { GifReader } from 'omggif';
import { PNG } from 'pngjs';
import decodeWebp, { init as initWebp } from '@jsquash/webp/decode.js';
import type { Bitmap } from './bitmap.js';
import { webpDecoderWasm } from './webp-decoder-wasm.js';

/**
 * The most pixels a decode may produce: about 6300 × 6300, 160 MB of RGBA. A
 * larger picture keeps its description, since decoding it could exhaust memory
 * before it is shrunk to what a terminal shows.
 */
export const MAX_DECODED_PIXELS = 40_000_000;

/** The size a PNG, GIF or WebP header declares, or null if the header cannot be read. */
export function declaredSize(bytes: Uint8Array, mediaType: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));
  try {
    switch (mediaType) {
      case 'image/png':
        // The signature, then the IHDR chunk: length, type, width, height.
        return ascii(12, 4) === 'IHDR' ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
      case 'image/gif':
        // The logical screen, which the first frame is drawn into.
        return ascii(0, 3) === 'GIF' ? { width: view.getUint16(6, true), height: view.getUint16(8, true) } : null;
      case 'image/webp': {
        if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP') return null;
        const chunk = ascii(12, 4);
        const u24 = (at: number): number => view.getUint16(at, true) + (view.getUint8(at + 2) << 16);
        if (chunk === 'VP8X') return { width: u24(24) + 1, height: u24(27) + 1 };
        if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
        if (chunk === 'VP8L') {
          const bits = view.getUint32(21, true);
          return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        return null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function checkSize(bytes: Uint8Array, mediaType: string): void {
  const size = declaredSize(bytes, mediaType);
  if (!size) throw new Error(`unreadable ${mediaType} header`);
  if (size.width * size.height > MAX_DECODED_PIXELS) {
    throw new Error(`${mediaType} of ${size.width}×${size.height} is too large to decode`);
  }
}

let webpReady: Promise<void> | undefined;

async function decodeWebpBitmap(bytes: Uint8Array): Promise<Bitmap> {
  webpReady ??= webpDecoderWasm().then((wasmBinary) => initWebp({ wasmBinary }));
  await webpReady;
  const image = await decodeWebp(bytes.slice().buffer);
  return { width: image.width, height: image.height, data: new Uint8Array(image.data.buffer) };
}

/**
 * Decode an inline image to RGBA pixels. These are the four types the runtime
 * shows inline; an animated GIF or WebP shows its first frame. Throws on any
 * other type, on bytes that do not decode, and on a picture of more than
 * `MAX_DECODED_PIXELS`, before allocating its pixels.
 */
export async function decodeImage(bytes: Uint8Array, mediaType: string): Promise<Bitmap> {
  // jpeg-js checks its own limit before it allocates; the others allocate the size their header declares.
  if (mediaType === 'image/png' || mediaType === 'image/gif' || mediaType === 'image/webp') checkSize(bytes, mediaType);
  switch (mediaType) {
    case 'image/png': {
      const png = PNG.sync.read(Buffer.from(bytes));
      return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
    }
    case 'image/jpeg': {
      const image = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: MAX_DECODED_PIXELS / 1_000_000,
      });
      return { width: image.width, height: image.height, data: image.data };
    }
    case 'image/gif': {
      const gif = new GifReader(bytes);
      const data = new Uint8Array(gif.width * gif.height * 4);
      gif.decodeAndBlitFrameRGBA(0, data);
      return { width: gif.width, height: gif.height, data };
    }
    case 'image/webp':
      return decodeWebpBitmap(bytes);
    default:
      throw new Error(`no decoder for ${mediaType}`);
  }
}
