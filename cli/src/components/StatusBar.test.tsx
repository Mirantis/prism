import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { StatusBar, contextColor, CONTEXT_GREEN } from './StatusBar.js';

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

  describe('context used', () => {
    it('hides the gauge entirely until the runtime has measured a turn', () => {
      // No placeholder: "0%" would claim an empty window the system prompt alone
      // disproves, and a dash is a gauge that reports nothing. The same applies
      // when the runtime does not recognize the model's window.
      const nullish = render(
        <StatusBar modelId="us.anthropic.claude-opus-5" status="idle" contextUsedPercent={null} />,
      );
      expect(nullish.lastFrame() ?? '').not.toContain('context');

      const absent = render(<StatusBar modelId="us.anthropic.claude-opus-5" status="idle" />);
      expect(absent.lastFrame() ?? '').not.toContain('context');
    });

    it('shows the used percentage once measured, in the "| context x%" format', () => {
      const { lastFrame } = render(
        <StatusBar modelId="us.anthropic.claude-opus-5" status="idle" contextUsedPercent={58} />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('| context 58%');
      // Still shows the model on the left — the reading is additive.
      expect(frame).toContain('Opus 5');
    });

    it('renders a fully-consumed window as 100%', () => {
      const { lastFrame } = render(
        <StatusBar modelId="us.anthropic.claude-opus-5" status="idle" contextUsedPercent={100} />,
      );
      expect(lastFrame() ?? '').toContain('| context 100%');
    });

    it('renders an untouched window as 0%', () => {
      const { lastFrame } = render(
        <StatusBar modelId="us.anthropic.claude-opus-5" status="idle" contextUsedPercent={0} />,
      );
      expect(lastFrame() ?? '').toContain('| context 0%');
    });

    it('reports an error alongside the gauge rather than hiding it', () => {
      const { lastFrame } = render(
        <StatusBar
          modelId="us.anthropic.claude-opus-5"
          status="error"
          detail="boom"
          contextUsedPercent={58}
        />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('error: boom');
      // Both are useful at once: the error says the link is down, the gauge still
      // says how much room the thread has left.
      expect(frame).toContain('| context 58%');
    });

    it('colours the reading green while there is room, yellow past 80%, red past 90%', () => {
      expect(contextColor(0)).toBe(CONTEXT_GREEN);
      expect(contextColor(58)).toBe(CONTEXT_GREEN);
      expect(contextColor(80)).toBe(CONTEXT_GREEN);
      expect(contextColor(81)).toBe('yellow');
      expect(contextColor(90)).toBe('yellow');
      expect(contextColor(91)).toBe('red');
      expect(contextColor(100)).toBe('red');
    });

    it('never colours the reading a near-background grey (regression)', () => {
      // The bug this feature actually shipped with: `gray` is ANSI bright-black,
      // which many themes render at or near their own background. The reading was
      // drawn, occupied its columns, and was invisible anyway. An explicit
      // mid-luminance hex is the fix, so guard against a relapse to a named dim.
      const dims = ['gray', 'grey', 'blackBright', 'black', 'dim'];
      for (const usedPercent of [0, 58, 80, 81, 95]) {
        expect(dims).not.toContain(contextColor(usedPercent));
      }
    });
  });
});
