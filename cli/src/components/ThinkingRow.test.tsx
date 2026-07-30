import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThinkingRow } from './ThinkingRow.js';

describe('ThinkingRow', () => {
  it('shows the in-flight hint while a turn is running', () => {
    const { lastFrame } = render(<ThinkingRow active />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
    expect(frame).toContain('esc to stop');
    // The affordance that says the composer below is still usable.
    expect(frame).toContain('enter sends');
  });

  it('keeps its line when idle so the composer does not jump', () => {
    const { lastFrame } = render(<ThinkingRow active={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('thinking');
    // One reserved (blank) line rather than nothing at all.
    expect(frame.split('\n')).toHaveLength(1);
  });
});
