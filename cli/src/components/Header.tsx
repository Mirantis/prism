import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';

interface Props {
  agentName: string;
}

// Block-element rendition of the Prism Agent mark with the "Prism" wordmark baked in.
// Gradient sweeps the Lens brand stops (#e97500 → #bf00ba) diagonally across
// the glyph.
const LOGO_ROWS = [
  '       ▗▙',
  '       ▄▄▖',
  '      ▟▛▀▀      ▄▖  ▘',
  '     ▟▛  ▝█▖    ▙▌▛▘▌▛▘▛▛▌',
  '    ▝▛    ▝█▖   ▌ ▌ ▌▄▌▌▌▌',
  '   ▟▖      ▝█▖',
  '  ▄▝█▄▄▄▄▄ ▟▛▗▖',
  ' ▝▀▘▝▀▀▀▀▘▝▀ ▀▀',
];

const GRADIENT_START = '#e97500';
const GRADIENT_END = '#bf00ba';

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpColor(start: string, end: string, t: number): string {
  const a = parseInt(start.slice(1), 16);
  const b = parseInt(end.slice(1), 16);
  const r = lerp((a >> 16) & 0xff, (b >> 16) & 0xff, t);
  const g = lerp((a >> 8) & 0xff, (b >> 8) & 0xff, t);
  const bl = lerp(a & 0xff, b & 0xff, t);
  return `#${[r, g, bl].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function colorRow(row: string, rowIndex: number, totalRows: number): string {
  // Mimic the SVG's diagonal gradient: position is (col + rowIndex) / total.
  const total = row.length + totalRows - 1;
  const chars = [...row];
  return chars
    .map((ch, col) => {
      if (ch === ' ') return ch;
      const t = (col + rowIndex) / (total - 1);
      return chalk.hex(lerpColor(GRADIENT_START, GRADIENT_END, t))(ch);
    })
    .join('');
}

export const Header: React.FC<Props> = ({ agentName }) => {
  return (
    <Box
      borderStyle="round"
      borderColor="magenta"
      paddingX={2}
      marginBottom={1}
      alignItems="center"
      justifyContent="space-between"
    >
      <Box flexDirection="column">
        {LOGO_ROWS.map((row, i) => (
          <Text key={i}>{colorRow(row, i, LOGO_ROWS.length)}</Text>
        ))}
      </Box>
      <Text dimColor>chat with {agentName}  ·  ctrl+c to exit</Text>
    </Box>
  );
};
