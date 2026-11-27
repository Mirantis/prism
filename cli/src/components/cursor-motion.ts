/**
 * Cursor moves for the composer's editing keys. Each function takes the value
 * and an offset into it in UTF-16 units, as `TextInput` counts them, and gives
 * back the new offset. A column is counted in the same units, so Up and Down
 * over wide characters can land one cell to the side, and inside an emoji as
 * Left and Right can.
 */

import type { Key } from 'ink';
import wrapAnsi from 'wrap-ansi';

// A combining mark belongs to the letter before it, so a word move never splits the pair.
const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;

const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && WORD_CHAR.test(char);

export function lineStart(value: string, offset: number): number {
  if (offset === 0) return 0;
  return value.lastIndexOf('\n', offset - 1) + 1;
}

export function lineEnd(value: string, offset: number): number {
  const newline = value.indexOf('\n', offset);
  return newline === -1 ? value.length : newline;
}

export function wordLeft(value: string, offset: number): number {
  let i = offset;
  while (i > 0 && !isWordChar(value[i - 1])) i--;
  while (i > 0 && isWordChar(value[i - 1])) i--;
  return i;
}

export function wordRight(value: string, offset: number): number {
  let i = offset;
  while (i < value.length && !isWordChar(value[i])) i++;
  while (i < value.length && isWordChar(value[i])) i++;
  return i;
}

/**
 * The target of a line or word key, or null when the key is not one of them.
 * Cmd+Left arrives as Ctrl+A, as Home or with the super modifier, depending on
 * the terminal.
 */
export function editingKeyTarget(
  value: string,
  offset: number,
  input: string,
  key: Key,
): number | null {
  if (key.home || (key.ctrl && input === 'a') || (key.super && key.leftArrow)) {
    return lineStart(value, offset);
  }
  if (key.end || (key.ctrl && input === 'e') || (key.super && key.rightArrow)) {
    return lineEnd(value, offset);
  }
  if (((key.meta || key.ctrl) && key.leftArrow) || (key.meta && input === 'b')) {
    return wordLeft(value, offset);
  }
  if (((key.meta || key.ctrl) && key.rightArrow) || (key.meta && input === 'f')) {
    return wordRight(value, offset);
  }
  return null;
}

function lineStarts(rendered: string): number[] {
  const starts = [0];
  for (let i = 0; i < rendered.length; i++) {
    if (rendered[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/**
 * The offset where each drawn row of `rendered` starts. Ink 8 wraps a `Text`
 * with wrap-ansi 10, the range `cli/package.json` requires, and these options, which insert `\n` at each soft break. They also
 * expand a tab and fold `\r\n`, and a value that has either gets one row per
 * line instead.
 */
function rowStarts(rendered: string, width: number): number[] {
  if (width <= 0) return lineStarts(rendered);
  const wrapped = wrapAnsi(rendered, width, { trim: false, hard: true });
  const starts = [0];
  let i = 0;
  for (let j = 0; j < wrapped.length; j++) {
    if (wrapped[j] !== '\n') {
      if (wrapped[j] !== rendered[i]) return lineStarts(rendered);
      i++;
      continue;
    }
    if (rendered[i] === '\n') i++;
    starts.push(i);
  }
  return i === rendered.length ? starts : lineStarts(rendered);
}

/**
 * The offset one drawn row up or down at the same column, or null when the
 * cursor is already on the first or last row. The rows are those of the value
 * as `TextInput` draws it at `width` columns: a cursor at the end or on a
 * newline draws as an extra cell at its offset.
 */
export function verticalTarget(
  value: string,
  offset: number,
  width: number,
  direction: 'up' | 'down',
): number | null {
  const cell = offset === value.length || value[offset] === '\n';
  const rendered = cell ? `${value.slice(0, offset)} ${value.slice(offset)}` : value;
  const drawnStarts = rowStarts(rendered, width);
  let row = drawnStarts.length - 1;
  while (row > 0 && drawnStarts[row]! > offset) row--;
  // Only the cursor's row holds the cell, so every later row starts one earlier in the value.
  const starts = cell ? drawnStarts.map((s) => (s > offset ? s - 1 : s)) : drawnStarts;

  const next = direction === 'up' ? row - 1 : row + 1;
  if (next < 0 || next >= starts.length) return null;

  const column = offset - starts[row]!;
  const lastOffset = next + 1 < starts.length ? starts[next + 1]! - 1 : value.length;
  return Math.min(starts[next]! + column, lastOffset);
}
