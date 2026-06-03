import React from 'react';
import { Box, Text } from 'ink';
import { SlashCommand } from '../commands.js';

interface Props {
  commands: SlashCommand[];
  selectedIndex: number;
}

const MAX_VISIBLE = 8;

export const CommandPopup: React.FC<Props> = ({ commands, selectedIndex }) => {
  if (commands.length === 0) return null;
  // Window the list around the selection so the highlighted command is always
  // on screen, even when there are more commands than MAX_VISIBLE.
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(MAX_VISIBLE / 2)),
    Math.max(0, commands.length - MAX_VISIBLE),
  );
  const visible = commands.slice(start, start + MAX_VISIBLE);
  return (
    <Box flexDirection="column" paddingX={2}>
      {visible.map((c, i) => {
        const selected = start + i === selectedIndex;
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
