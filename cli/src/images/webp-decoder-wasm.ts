import { readFile } from 'node:fs/promises';

/**
 * The WebP decoder's WebAssembly binary, read from its package. The `prism`
 * binary has no package directory, so `scripts/build-sea.mjs` swaps this module
 * for one that has the bytes inlined.
 */
export async function webpDecoderWasm(): Promise<Uint8Array> {
  return readFile(new URL(import.meta.resolve('@jsquash/webp/codec/dec/webp_dec.wasm')));
}
