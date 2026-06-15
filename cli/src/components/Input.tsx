import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { Spinner } from './Spinner.js';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled: boolean;
  hideCursor?: boolean;
}

export const Input: React.FC<Props> = ({ value, onChange, onSubmit, disabled, hideCursor }) => {
  return (
    <Box borderStyle="round" borderColor={disabled ? 'gray' : 'cyan'} paddingX={1}>
      <Box marginRight={1}>
        <Text color={disabled ? 'gray' : 'cyan'} bold>
          {'›'}
        </Text>
      </Box>
      {disabled ? (
        <Box>
          <Spinner />
          <Text dimColor italic> thinking… (esc to stop)</Text>
        </Box>
      ) : (
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          showCursor={!hideCursor}
        />
      )}
    </Box>
  );
};
