import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { SpinnerRow } from './SpinnerRow.js';

describe('SpinnerRow', () => {
  it('shows the caller-provided label while active', () => {
    const { lastFrame } = render(
      <SpinnerRow active label="thinking… (esc to stop · enter sends)" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
    expect(frame).toContain('esc to stop');
    // The affordance that says the composer below is still usable.
    expect(frame).toContain('enter sends');
  });

  it('keeps its line when idle so the composer does not jump', () => {
    const { lastFrame } = render(<SpinnerRow active={false} label="thinking…" />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('thinking');
    // One reserved (blank) line rather than nothing at all.
    expect(frame.split('\n')).toHaveLength(1);
  });
});
