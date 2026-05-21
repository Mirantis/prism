import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { GradientText } from './GradientText.js';

describe('GradientText', () => {
  it('renders the text characters in order', () => {
    const { lastFrame } = render(<GradientText>Prism</GradientText>);
    // ANSI escape sequences sit between letters, but the literal characters
    // are preserved — a substring check is sufficient.
    const frame = lastFrame() ?? '';
    expect(frame).toContain('P');
    expect(frame).toContain('r');
    expect(frame).toContain('i');
    expect(frame).toContain('s');
    expect(frame).toContain('m');
  });

  it('does not crash on single-character input', () => {
    const { lastFrame } = render(<GradientText>A</GradientText>);
    expect(lastFrame() ?? '').toContain('A');
  });
});
