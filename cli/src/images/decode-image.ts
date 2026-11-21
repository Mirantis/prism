import jpeg from 'jpeg-js';
import { GifReader } from 'omggif';
import { PNG } from 'pngjs';
import decodeWebp, { init as initWebp } from '@jsquash/webp/decode.js';
import type { Bitmap } from './bitmap.js';
import { webpDecoderWasm } from './webp-decoder-wasm.js';

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
 * other type and on bytes that do not decode.
 */
export async function decodeImage(bytes: Uint8Array, mediaType: string): Promise<Bitmap> {
  switch (mediaType) {
    case 'image/png': {
      const png = PNG.sync.read(Buffer.from(bytes));
      return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
    }
    case 'image/jpeg': {
      const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
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
