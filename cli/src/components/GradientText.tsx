import React from 'react';
import { Text } from 'ink';
import chalk from 'chalk';

// Chalk hex colors to walk along, mimicking ink-gradient's "pastel" feel.
const STOPS = ['#ff6ec7', '#ffb86c', '#ffe66d', '#7af1ff', '#a78bfa'];

function lerpHex(a: string, b: string, t: number): string {
  const ai = parseInt(a.slice(1), 16);
  const bi = parseInt(b.slice(1), 16);
  const ar = (ai >> 16) & 0xff;
  const ag = (ai >> 8) & 0xff;
  const ab = ai & 0xff;
  const br = (bi >> 16) & 0xff;
  const bg = (bi >> 8) & 0xff;
  const bb = bi & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${[r, g, bl].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function colorAt(progress: number): string {
  const segments = STOPS.length - 1;
  const scaled = progress * segments;
  const idx = Math.min(segments - 1, Math.floor(scaled));
  const local = scaled - idx;
  return lerpHex(STOPS[idx]!, STOPS[idx + 1]!, local);
}

interface Props {
  children: string;
  bold?: boolean;
}

export const GradientText: React.FC<Props> = ({ children, bold }) => {
  const chars = [...children];
  const colored = chars
    .map((ch, i) => {
      const t = chars.length === 1 ? 0 : i / (chars.length - 1);
      const styled = chalk.hex(colorAt(t))(ch);
      return bold ? chalk.bold(styled) : styled;
    })
    .join('');
  return <Text>{colored}</Text>;
};
