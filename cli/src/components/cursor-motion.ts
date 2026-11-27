/**
 * Cursor moves for the composer's editing keys. Each function takes the value
 * and an offset into it in UTF-16 units, as `TextInput` counts them, and gives
 * back the new offset.
 */

import type { Key } from 'ink';

const WORD_CHAR = /[\p{L}\p{N}_]/u;

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
