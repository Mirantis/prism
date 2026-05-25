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

  it('caps the visible list at MAX_VISIBLE (6) entries', () => {
    const many: SlashCommand[] = Array.from({ length: 10 }, (_, i) => ({
      name: `/cmd${i}`,
      description: `desc ${i}`,
      run: noop,
    }));
    const { lastFrame } = render(<CommandPopup commands={many} selectedIndex={0} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/cmd0');
    expect(frame).toContain('/cmd5');
    expect(frame).not.toContain('/cmd6');
  });
});
