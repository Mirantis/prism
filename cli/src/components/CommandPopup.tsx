import React from 'react';
import { Box, Text } from 'ink';

/**
 * Generic popup row. Slash commands satisfy this structurally; the /attach
 * path completion maps filesystem suggestions into it.
 */
export interface PopupItem {
  name: string;
  description: string;
}

interface Props {
  items: PopupItem[];
  selectedIndex: number;
}

const MAX_VISIBLE = 8;

export const CommandPopup: React.FC<Props> = ({ items, selectedIndex }) => {
  if (items.length === 0) return null;
  // Window the list around the selection so the highlighted item is always
  // on screen, even when there are more items than MAX_VISIBLE.
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(MAX_VISIBLE / 2)),
    Math.max(0, items.length - MAX_VISIBLE),
  );
  const visible = items.slice(start, start + MAX_VISIBLE);
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
