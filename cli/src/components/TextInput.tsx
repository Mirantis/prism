/**
 * TextInput — a fork of `ink-text-input@6.0.0` (MIT). See `THIRD_PARTY_NOTICES`.
 *
 * One behavioural change from upstream: a key carrying **Ctrl**, and a lone
 * **Escape**, are ignored instead of being inserted as their bare letter.
 *
 * Why we vendor it. Upstream's guard only skips up/down/tab/shift+tab/ctrl+c, so
 * Ink hands Ctrl+O in as `input === 'o'` and it lands in the value. `App` also
 * binds Ctrl+O (expand tool calls) and Escape (cancel the turn), but Ink
 * dispatches `useInput` handlers in listener-registration order — which is
 * effect order, child before parent — so this component sees the chord first and
 * App's handler cannot pre-empt it. That used to be masked: the composer was
 * swapped for a spinner on every turn boundary, and each remount re-registered
 * this listener last. The composer now stays mounted for the whole turn so a
 * user can steer it mid-response, and that accident is gone.
 *
 * Filtering here settles it by construction rather than by mount order: chords
 * belong to `App`, never to the value. `key.meta` is deliberately NOT filtered —
 * Ink sets it for Option+Enter, which must keep submitting.
 *
 * Everything else is upstream's logic, transcribed to TSX, less `placeholder`,
 * `highlightPastedText` and `UncontrolledTextInput`, which nothing here uses.
 */

import React, { useState, useEffect } from 'react';
import { Text, useInput } from 'ink';
import chalk from 'chalk';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  /** Accept keystrokes. When false the component renders but binds nothing. */
  focus?: boolean;
  /** Draw the fake block cursor (upstream's `showCursor`). */
  showCursor?: boolean;
  /** Draw each character as this instead, for a password field. */
  mask?: string;
}

export const TextInput: React.FC<Props> = ({
  value: originalValue,
  onChange,
  onSubmit,
  focus = true,
  showCursor = true,
  mask,
}) => {
  const [cursorOffset, setCursorOffset] = useState((originalValue || '').length);

  // Keep the cursor inside the value when it changes from the outside (history
  // recall, a programmatic clear after submit).
  useEffect(() => {
    setCursorOffset((previous) => {
      if (!focus || !showCursor) return previous;
      const next = originalValue || '';
      return previous > next.length - 1 ? next.length : previous;
    });
  }, [originalValue, focus, showCursor]);

  // Fake block cursor: dealing with the real one plus ANSI escapes is worse.
  const shownValue = mask ? mask.repeat(originalValue.length) : originalValue;
  let renderedValue = shownValue;
  if (showCursor && focus) {
    renderedValue = shownValue.length > 0 ? '' : chalk.inverse(' ');
    let i = 0;
    for (const char of shownValue) {
      renderedValue += i === cursorOffset ? chalk.inverse(char) : char;
      i++;
    }
    if (shownValue.length > 0 && cursorOffset === shownValue.length) {
      renderedValue += chalk.inverse(' ');
    }
  }

  useInput(
    (input, key) => {
      if (
        key.upArrow ||
        key.downArrow ||
        key.tab ||
        (key.shift && key.tab) ||
        // App cancels the in-flight turn on Escape; upstream let it fall through
        // and clamp the cursor.
        key.escape ||
        // The fix. Subsumes upstream's lone `ctrl && input === 'c'` case.
        key.ctrl
      ) {
        return;
      }

      if (key.return) {
        onSubmit?.(originalValue);
        return;
      }

      let nextCursorOffset = cursorOffset;
      let nextValue = originalValue;

      if (key.leftArrow) {
        if (showCursor) nextCursorOffset--;
      } else if (key.rightArrow) {
        if (showCursor) nextCursorOffset++;
      } else if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          nextValue =
            originalValue.slice(0, cursorOffset - 1) +
            originalValue.slice(cursorOffset, originalValue.length);
          nextCursorOffset--;
        }
      } else {
        nextValue =
          originalValue.slice(0, cursorOffset) +
          input +
          originalValue.slice(cursorOffset, originalValue.length);
        nextCursorOffset += input.length;
      }

      if (cursorOffset < 0) nextCursorOffset = 0;
      if (cursorOffset > originalValue.length) nextCursorOffset = originalValue.length;

      setCursorOffset(nextCursorOffset);
      if (nextValue !== originalValue) onChange(nextValue);
    },
    { isActive: focus },
  );

  return <Text>{renderedValue}</Text>;
};

export default TextInput;
