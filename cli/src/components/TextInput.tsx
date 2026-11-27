/**
 * TextInput — a fork of `ink-text-input@6.0.0` (MIT). See `THIRD_PARTY_NOTICES`.
 *
 * Behaviour changes from upstream:
 *
 * - A key carrying **Ctrl**, and a lone **Escape**, are ignored instead of being
 *   inserted as their bare letter. The editing chords below are the exception.
 * - Home, End, Ctrl+A, Ctrl+E and Cmd+Left/Right go to the start or end of the
 *   line. Option+Left/Right, Meta+B/F and Ctrl+Left/Right move one word
 *   (`cursor-motion.ts`).
 * - With `onVerticalEdge`, Up and Down move one drawn row. On the first or last
 *   row they call `onVerticalEdge` instead. Without it they are ignored, as
 *   upstream ignores them.
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
 * belong to `App`, never to the value. Up and Down follow the same rule: the
 * cursor offset is state here, so this handler chooses whether a key moves the
 * cursor or goes to `App` through `onVerticalEdge`. `key.meta` is deliberately
 * NOT filtered — Ink sets it for Option+Enter, which must keep submitting.
 *
 * Everything else is upstream's logic, transcribed to TSX, less `placeholder`,
 * `highlightPastedText` and `UncontrolledTextInput`, which nothing here uses.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, measureElement, useInput, type DOMElement } from 'ink';
import chalk from 'chalk';
import { isLateProbeReply } from '../images/terminal-graphics.js';
import { editingKeyTarget, verticalTarget } from './cursor-motion.js';

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
  /** Up on the first drawn row or Down on the last. Without it, Up and Down are ignored. */
  onVerticalEdge?: (direction: 'up' | 'down') => void;
}

export const TextInput: React.FC<Props> = ({
  value: originalValue,
  onChange,
  onSubmit,
  focus = true,
  showCursor = true,
  mask,
  onVerticalEdge,
}) => {
  const boxRef = useRef<DOMElement>(null);
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
      if (i !== cursorOffset) renderedValue += char;
      // An inverse newline shows nothing, so a cursor on one draws as a cell before it.
      else if (char === '\n') renderedValue += `${chalk.inverse(' ')}\n`;
      else renderedValue += chalk.inverse(char);
      i++;
    }
    if (shownValue.length > 0 && cursorOffset === shownValue.length) {
      renderedValue += chalk.inverse(' ');
    }
  }

  useInput(
    (input, key) => {
      if (
        key.tab ||
        (key.shift && key.tab) ||
        // App cancels the in-flight turn on Escape; upstream let it fall through
        // and clamp the cursor.
        key.escape ||
        // The terminal's answer to the start-up graphics probe, arriving late over a slow link.
        isLateProbeReply(input)
      ) {
        return;
      }

      if (key.upArrow || key.downArrow) {
        if (!onVerticalEdge) return;
        const direction = key.upArrow ? 'up' : 'down';
        // Ink wraps the text at the text node's own width, which can be one column
        // wider than the box when the cursor cell overflows into the padding.
        const textNode = boxRef.current?.childNodes[0] as DOMElement | undefined;
        const width = textNode ? measureElement(textNode).width : 0;
        const target = showCursor
          ? verticalTarget(shownValue, cursorOffset, width, direction)
          : null;
        if (target === null) onVerticalEdge(direction);
        else setCursorOffset(target);
        return;
      }

      const target = editingKeyTarget(originalValue, cursorOffset, input, key);
      if (target !== null) {
        if (showCursor) setCursorOffset(target);
        return;
      }

      // The fix. Subsumes upstream's lone `ctrl && input === 'c'` case.
      if (key.ctrl) return;

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

      if (nextCursorOffset < 0) nextCursorOffset = 0;
      if (nextCursorOffset > nextValue.length) nextCursorOffset = nextValue.length;

      setCursorOffset(nextCursorOffset);
      if (nextValue !== originalValue) onChange(nextValue);
    },
    { isActive: focus },
  );

  // The box gives Up and Down a handle on the text node, which takes no ref.
  return (
    <Box ref={boxRef}>
      <Text>{renderedValue}</Text>
    </Box>
  );
};

export default TextInput;
