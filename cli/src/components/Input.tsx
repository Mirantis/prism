import React from 'react';
import { Box, Text } from 'ink';
import { TextInput } from './TextInput.js';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  hideCursor?: boolean;
}

/**
 * The composer. Live at all times — including while the agent is responding, so
 * a message typed mid-turn is handed to that turn and can redirect it (the
 * runtime decides; see `SpinnerRow` for the in-flight indicator that used to
 * sit here in the input's place).
 */
export const Input: React.FC<Props> = ({ value, onChange, onSubmit, hideCursor }) => {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box marginRight={1}>
        <Text color="cyan" bold>
          {'›'}
        </Text>
      </Box>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        showCursor={!hideCursor}
      />
    </Box>
  );
};
