import React from 'react';
import { Box, Text } from 'ink';
import { TuiStatus } from '../tui-adapter.js';

interface Props {
  modelId: string;
  status: TuiStatus;
  detail?: string;
  /**
   * Share of the model's context window this thread has consumed, as an integer
   * percentage. Null until the runtime has measured a turn, or when it doesn't
   * recognize the model's window — in both cases nothing is shown rather than a
   * guess.
   */
  contextUsedPercent?: number | null;
}

// Map Bedrock model IDs like "us.anthropic.claude-opus-4-7",
// "us.anthropic.claude-opus-5" or "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
// to a short display name (e.g. "Opus 4.7", "Opus 5", "Sonnet 4.5"). The minor
// version is optional so ids without one ("claude-opus-5") render as just
// "Opus 5". The minor is bounded to 1-2 digits followed by a delimiter so a
// trailing date on a minor-less id ("claude-opus-5-20251001-v1:0") isn't
// mistaken for the minor version. Falls back to the raw id when the pattern
// doesn't match — keeps the status bar honest for unknown / non-Claude models.
function prettifyModelId(id: string): string {
  const m = id.match(/claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?=-|$))?/);
  if (!m) return id;
  const [, family, major, minor] = m;
  const titled = family.charAt(0).toUpperCase() + family.slice(1);
  return minor ? `${titled} ${major}.${minor}` : `${titled} ${major}`;
}

/**
 * Green while there's room, yellow past 80% consumed, red past 90%.
 *
 * An explicit mid-luminance hex, not Ink's `gray` and not a named ANSI colour.
 * `gray` is ANSI bright-black, which many themes render at or near their own
 * background — the reading was drawn, occupied its columns, and was still
 * unreadable. Named colours inherit the terminal's palette, so their luminance
 * is whatever the theme says. This green is legible on light and dark alike.
 */
export const CONTEXT_GREEN = '#3fb950';

/** Exported for the unit test: Ink strips colour without a TTY, so the decision
 *  is asserted here rather than on the rendered escape sequences. */
export function contextColor(usedPercent: number): string {
  if (usedPercent > 90) return 'red';
  if (usedPercent > 80) return 'yellow';
  return CONTEXT_GREEN;
}

export const StatusBar: React.FC<Props> = ({ modelId, status, detail, contextUsedPercent }) => {
  const showContext = typeof contextUsedPercent === 'number';
  return (
    // One left-aligned row: the leading pipe in "| context 58%" reads as a
    // separator after the model name, so the reading belongs beside it.
    <Box marginTop={1}>
      <Text color="#7c3aed">{prettifyModelId(modelId)}</Text>
      {/*
        Hidden outright until the runtime has measured a turn and recognizes the
        model's window. There is no placeholder reading: "0%" would claim an empty
        window the system prompt alone disproves, and a dash is a gauge that
        reports nothing.
      */}
      {showContext ? (
        <Text color={contextColor(contextUsedPercent)}>{` | context ${contextUsedPercent}%`}</Text>
      ) : null}
      {/* An error is appended, so it reports alongside the gauge instead of hiding it. */}
      {status === 'error' ? <Text color="red"> ● error{detail ? `: ${detail}` : ''}</Text> : null}
    </Box>
  );
};
