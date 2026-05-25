import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Header } from './Header.js';

describe('Header', () => {
  it('renders the agent name in the right-side hint', () => {
    const { lastFrame } = render(<Header agentName="Prism" />);
    expect(lastFrame() ?? '').toContain('chat with Prism');
    expect(lastFrame() ?? '').toContain('ctrl+c to exit');
  });

  it('reflects a custom agent name', () => {
    const { lastFrame } = render(<Header agentName="Bobby" />);
    expect(lastFrame() ?? '').toContain('chat with Bobby');
  });

  it('renders the logo glyphs (block-element rows)', () => {
    const { lastFrame } = render(<Header agentName="Prism" />);
    const frame = lastFrame() ?? '';
    // Sample a few characters from the logo art; ANSI escapes around them
    // don't affect substring matching of the raw codepoints.
    expect(frame).toContain('▙');
    expect(frame).toContain('▟');
  });
});
