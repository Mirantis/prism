import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Input } from './Input.js';

describe('Input', () => {
  it('renders the prompt glyph and the current value when not disabled', () => {
    const { lastFrame } = render(
      <Input
        value="hello"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('›');
    expect(frame).toContain('hello');
  });

  it('replaces the text input with a thinking indicator when disabled', () => {
    const { lastFrame } = render(
      <Input
        value="ignored"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
    // Value is not rendered while disabled.
    expect(frame).not.toContain('ignored');
  });

  it('respects hideCursor (no crash; renders the value)', () => {
    const { lastFrame } = render(
      <Input
        value="abc"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        hideCursor
      />,
    );
    expect(lastFrame() ?? '').toContain('abc');
  });
});
