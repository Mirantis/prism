/**
 * The kitty graphics protocol, Unicode-placeholder form
 * (https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders).
 *
 * The terminal stores the picture once, under an id, with a virtual placement of
 * a fixed size in cells. The picture then shows wherever the screen holds its
 * placeholder cells: U+10EEEE colored with the id, a diacritic naming the row.
 * The placeholders are ordinary text to Ink, so a redraw, a scroll or a resize
 * moves the picture with the text around it.
 */

import { deflateSync } from 'node:zlib';
import type { Bitmap } from './bitmap.js';

const PLACEHOLDER = '\u{10EEEE}';

/**
 * The first entries of kitty's row/column diacritics table
 * (`gen/rowcolumn-diacritics.txt`): the diacritic at index n means row or column n.
 * It covers `MAX_IMAGE_ROWS`.
 */
const DIACRITICS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c,
  0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
  0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592,
  0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1,
].map((code) => String.fromCodePoint(code));

/** The terminal accepts a chunk of at most 4096 bytes of base64. */
const CHUNK = 4096;

/**
 * The escape sequences that store `bitmap` under `id` and give it a virtual
 * placement of `cols` × `rows` cells. The pixels are sent zlib-compressed, and
 * `q=2` keeps the terminal from answering.
 */
export function kittyTransmit(bitmap: Bitmap, id: number, cols: number, rows: number): string {
  const payload = deflateSync(bitmap.data).toString('base64');
  const keys = `a=T,U=1,i=${id},c=${cols},r=${rows},f=32,s=${bitmap.width},v=${bitmap.height},o=z,q=2`;
  let out = '';
  for (let at = 0; at < payload.length; at += CHUNK) {
    const more = at + CHUNK < payload.length ? 1 : 0;
    const control = at === 0 ? `${keys},m=${more}` : `q=2,m=${more}`;
    out += `\x1b_G${control};${payload.slice(at, at + CHUNK)}\x1b\\`;
  }
  return out;
}

/**
 * The placeholder text for the placement of image `id`: one line per row. The
 * first cell of a row names its row and column 0, and each later cell is the
 * next column. The foreground color holds the 24-bit id.
 */
export function kittyPlaceholderLines(id: number, cols: number, rows: number): string[] {
  const color = `\x1b[38;2;${(id >> 16) & 0xff};${(id >> 8) & 0xff};${id & 0xff}m`;
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    lines.push(`${color}${PLACEHOLDER}${DIACRITICS[row]}${DIACRITICS[0]}${PLACEHOLDER.repeat(cols - 1)}\x1b[39m`);
  }
  return lines;
}
