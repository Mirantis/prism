import React from 'react';
import { Box, Text } from 'ink';
import { Spinner } from './Spinner.js';

interface Props {
  /** True while an activity is in flight. */
  active: boolean;
  /** What the spinner is doing, e.g. "thinking…" — the caller owns the wording. */
  label: string;
}

/**
 * The in-flight indicator, on its own line above the composer: a spinner plus
 * whatever activity label the caller passes (a chat turn thinking, a
 * compaction running, …).
 *
 * It used to render *inside* the input box, in place of the text field — which is
 * what stopped a user from typing while the agent worked. It lives here so the
 * composer can stay live for the whole turn.
 *
 * The row keeps its line when idle (`minHeight`) so the composer does not jump up
 * and down at turn boundaries while someone is typing into it. It is part of the
 * chat surface rather than the status bar because `--no-status-bar` would
 * otherwise hide both the spinner and the only "esc to stop" affordance.
 */
export const SpinnerRow: React.FC<Props> = ({ active, label }) => {
  return (
    <Box paddingX={2} minHeight={1}>
      {active && (
        <>
          <Spinner />
          <Text dimColor italic> {label}</Text>
        </>
      )}
    </Box>
  );
};
