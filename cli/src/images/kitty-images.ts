/**
 * The pictures this process has stored in the terminal. Each attachment shown at
 * one size is one kitty image, stored once and kept: placeholders in the
 * scrollback still show it after a resize or a redraw.
 */

import { resizeBitmap, type Bitmap } from './bitmap.js';
import { kittyTransmit } from './kitty.js';

// Placeholder colors hold 24 bits. A random start keeps two clients in one
// terminal from taking the same ids.
let nextId = 0x100000 + Math.floor(Math.random() * 0xe00000);
const ids = new Map<string, number>();
const sent = new Set<number>();

/** The kitty image id of attachment `attachmentId` drawn in `cols` × `rows` cells. */
export function kittyImageId(attachmentId: string, cols: number, rows: number): number {
  const key = `${attachmentId}:${cols}x${rows}`;
  let id = ids.get(key);
  if (id === undefined) {
    id = nextId++;
    ids.set(key, id);
  }
  return id;
}

/**
 * Store the picture under `id` the first time it is shown, at no more pixels
 * than its cells show.
 */
export function sendKittyImage(
  id: number,
  bitmap: Bitmap,
  cols: number,
  rows: number,
  cell: { width: number; height: number },
  write: (sequence: string) => void,
): void {
  if (sent.has(id)) return;
  sent.add(id);
  const scale = Math.min(1, (cols * cell.width) / bitmap.width, (rows * cell.height) / bitmap.height);
  const pixels = resizeBitmap(
    bitmap,
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)),
  );
  write(kittyTransmit(pixels, id, cols, rows));
}
