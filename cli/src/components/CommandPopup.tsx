import React from 'react';
import { Box, Text } from 'ink';
import { SlashCommand } from '../commands.js';

interface Props {
  commands: SlashCommand[];
  selectedIndex: number;
}

const MAX_VISIBLE = 6;

export const CommandPopup: React.FC<Props> = ({ commands, selectedIndex }) => {
  if (commands.length === 0) return null;
  const visible = commands.slice(0, MAX_VISIBLE);
  return (
    <Box flexDirection="column" paddingX={2}>
      {visible.map((c, i) => {
        const selected = i === selectedIndex;
        return (
          <Box key={c.name}>
            <Text color={selected ? 'cyan' : undefined} bold={selected}>
              {selected ? '▸ ' : '  '}
              {c.name}
            </Text>
            <Text dimColor>{'  '}{c.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
};
