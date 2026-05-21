import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { StatusBar } from './StatusBar.js';

describe('StatusBar', () => {
  it('pretty-prints a known Bedrock Claude model id', () => {
    const { lastFrame } = render(
      <StatusBar modelId="us.anthropic.claude-opus-4-7" status="idle" />,
    );
    expect(lastFrame() ?? '').toContain('Opus 4.7');
  });

  it('falls back to the raw id when the pattern does not match', () => {
    const { lastFrame } = render(<StatusBar modelId="something-else" status="idle" />);
    expect(lastFrame() ?? '').toContain('something-else');
  });

  it('renders the error label only when status is "error"', () => {
    const idle = render(<StatusBar modelId="disconnected" status="idle" />);
    expect(idle.lastFrame() ?? '').not.toContain('error');

    const errored = render(
      <StatusBar modelId="disconnected" status="error" detail="boom" />,
    );
    const frame = errored.lastFrame() ?? '';
    expect(frame).toContain('error');
    expect(frame).toContain('boom');
  });

  it('omits the colon-detail suffix when no detail is given', () => {
    const { lastFrame } = render(<StatusBar modelId="disconnected" status="error" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('error');
    expect(frame).not.toMatch(/error:/);
  });
});
