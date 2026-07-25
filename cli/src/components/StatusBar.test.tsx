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

  it('renders a model id without a minor version', () => {
    const { lastFrame } = render(
      <StatusBar modelId="us.anthropic.claude-opus-5" status="idle" />,
    );
    expect(lastFrame() ?? '').toContain('Opus 5');
  });

  it('renders a major.minor model id (regression)', () => {
    const { lastFrame } = render(
      <StatusBar modelId="us.anthropic.claude-opus-4-8" status="idle" />,
    );
    expect(lastFrame() ?? '').toContain('Opus 4.8');
  });

  it('renders a dated/suffixed model id using only the major.minor segments', () => {
    const { lastFrame } = render(
      <StatusBar modelId="us.anthropic.claude-haiku-4-5-20251001-v1:0" status="idle" />,
    );
    expect(lastFrame() ?? '').toContain('Haiku 4.5');
  });

  it('ignores a trailing date on a minor-less id', () => {
    const { lastFrame } = render(
      <StatusBar modelId="us.anthropic.claude-opus-5-20251001-v1:0" status="idle" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Opus 5');
    expect(frame).not.toContain('20251001');
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
