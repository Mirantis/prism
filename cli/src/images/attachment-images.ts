import { apiClient } from '../api-client.js';
import type { AttachmentMeta } from '../attachments.js';
import { resizeBitmap, type Bitmap } from './bitmap.js';
import { decodeImage } from './decode-image.js';

/** The longest side a decoded picture keeps: more than any terminal shows of it. */
const MAX_SIDE = 2048;

/** The most decoded pixel bytes kept for pictures not on screen: four pictures at the largest size. */
export const CACHE_BYTES = 4 * MAX_SIDE * MAX_SIDE * 4;

// A stored attachment never changes, so a decoded picture is kept for the next
// render, most recently used last. Pictures past `CACHE_BYTES` are dropped and
// load again when shown; the terminal keeps what it was sent either way. A
// failed load is dropped at once, so the next render tries again.
const loads = new Map<string, Promise<Bitmap>>();
const sizes = new Map<string, number>();
let cachedBytes = 0;

function forget(id: string): void {
  loads.delete(id);
  cachedBytes -= sizes.get(id) ?? 0;
  sizes.delete(id);
}

function keep(id: string, bytes: number): void {
  sizes.set(id, bytes);
  cachedBytes += bytes;
  for (const old of loads.keys()) {
    if (cachedBytes <= CACHE_BYTES) break;
    if (old !== id && sizes.has(old)) forget(old);
  }
}

function shrink(bitmap: Bitmap): Bitmap {
  const scale = MAX_SIDE / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) return bitmap;
  return resizeBitmap(bitmap, Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
}

/** Download an inline image attachment and decode it to pixels. */
export function loadAttachmentImage(attachment: AttachmentMeta): Promise<Bitmap> {
  const id = attachment.id;
  const cached = loads.get(id);
  if (cached) {
    loads.delete(id);
    loads.set(id, cached);
    return cached;
  }
  const load = apiClient
    .downloadAttachment(id)
    .then((bytes) => decodeImage(new Uint8Array(bytes), attachment.mediaType))
    .then(shrink);
  loads.set(id, load);
  load.then(
    (bitmap) => {
      if (loads.get(id) === load) keep(id, bitmap.data.byteLength);
    },
    () => {
      if (loads.get(id) === load) forget(id);
    },
  );
  return load;
}

/** Drop every kept picture. For tests. */
export function clearAttachmentImages(): void {
  loads.clear();
  sizes.clear();
  cachedBytes = 0;
}
