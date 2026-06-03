import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { CommandPopup } from './CommandPopup.js';
import type { SlashCommand } from '../commands.js';

const noop = async () => '';

const commands: SlashCommand[] = [
  { name: '/copy', description: 'Copy last message', run: noop },
  { name: '/exit', description: 'Shut down', run: noop },
];

describe('CommandPopup', () => {
  it('renders nothing when the command list is empty', () => {
    const { lastFrame } = render(<CommandPopup commands={[]} selectedIndex={0} />);
    expect(lastFrame() ?? '').toBe('');
  });

  it('renders each command name and description', () => {
    const { lastFrame } = render(<CommandPopup commands={commands} selectedIndex={0} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/copy');
    expect(frame).toContain('Copy last message');
    expect(frame).toContain('/exit');
    expect(frame).toContain('Shut down');
  });

  it('marks the selected command with a ▸ pointer', () => {
    const { lastFrame } = render(<CommandPopup commands={commands} selectedIndex={1} />);
    const frame = lastFrame() ?? '';
    // The selected row has '▸ /exit'; the other has two leading spaces.
    expect(frame).toMatch(/▸ \/exit/);
  });

  it('windows the visible list around the selection at MAX_VISIBLE (8) entries', () => {
    const many: SlashCommand[] = Array.from({ length: 12 }, (_, i) => ({
      name: `/cmd${i}`,
      description: `desc ${i}`,
      run: noop,
    }));
    // Selection near the end: the window scrolls so the highlighted row stays
    // visible and the earliest commands fall off the top.
    const { lastFrame } = render(<CommandPopup commands={many} selectedIndex={11} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/▸ \/cmd11/); // selected row is visible
    expect(frame).not.toContain('/cmd0'); // earliest scrolled out of the window
    // Exactly MAX_VISIBLE command rows render.
    expect((frame.match(/\/cmd\d+/g) ?? []).length).toBe(8);
  });
});
