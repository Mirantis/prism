import { apiClient } from '../api-client.js';
import type { AttachmentMeta } from '../attachments.js';
import { resizeBitmap, type Bitmap } from './bitmap.js';
import { decodeImage } from './decode-image.js';

/** The longest side a decoded picture keeps: more than any terminal shows of it. */
const MAX_SIDE = 2048;

// A stored attachment never changes, so each one is downloaded and decoded once
// per process. A failed load stays failed and the message keeps the description.
const loads = new Map<string, Promise<Bitmap>>();

function shrink(bitmap: Bitmap): Bitmap {
  const scale = MAX_SIDE / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) return bitmap;
  return resizeBitmap(bitmap, Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
}

/** Download an inline image attachment and decode it to pixels. */
export function loadAttachmentImage(attachment: AttachmentMeta): Promise<Bitmap> {
  let load = loads.get(attachment.id);
  if (!load) {
    load = apiClient
      .downloadAttachment(attachment.id)
      .then((bytes) => decodeImage(new Uint8Array(bytes), attachment.mediaType))
      .then(shrink);
    loads.set(attachment.id, load);
  }
  return load;
}
