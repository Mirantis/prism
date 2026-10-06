// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ContextMeter from './context-meter';
import type { ContextUsage } from '@lensapp/prism-client';

afterEach(cleanup);

function usage(overrides: Partial<ContextUsage> = {}): ContextUsage {
  return {
    threadId: 'thread-1',
    modelId: 'us.anthropic.claude-opus-5',
    usedTokens: 580_000,
    windowTokens: 1_000_000,
    usedPercent: 58,
    ...overrides,
  };
}

describe('ContextMeter', () => {
  it('states how much context has been used', () => {
    // The runtime reports consumption directly, so the value is rendered verbatim.
    render(<ContextMeter usage={usage({ usedPercent: 58 })} />);
    expect(screen.getByTestId('context-meter')).toHaveTextContent('58% context used');
  });

  it('agrees with the tooltip figures', () => {
    // 580,000 of 1,000,000 is 58% consumed; the label and tooltip must not tell
    // two different stories.
    render(<ContextMeter usage={usage({ usedTokens: 580_000, windowTokens: 1_000_000, usedPercent: 58 })} />);
    const el = screen.getByTestId('context-meter');
    expect(el).toHaveTextContent('58% context used');
    expect(el).toHaveAttribute('title', expect.stringContaining('580,000 of 1,000,000'));
  });

  it('exposes the raw counts and model in the tooltip', () => {
    // The percentage alone hides which model's window it is measured against —
    // relevant because a thread's model can change between turns.
    render(<ContextMeter usage={usage()} />);
    expect(screen.getByTestId('context-meter')).toHaveAttribute(
      'title',
      '580,000 of 1,000,000 tokens used (us.anthropic.claude-opus-5)'
    );
  });

  it('stays muted while there is plenty of room (58% used)', () => {
    render(<ContextMeter usage={usage({ usedPercent: 58 })} />);
    expect(screen.getByTestId('context-meter').className).toContain('text-muted-foreground');
  });

  it('warns in amber above 80% used', () => {
    render(<ContextMeter usage={usage({ usedPercent: 85 })} />);
    expect(screen.getByTestId('context-meter').className).toContain('text-amber-600');
  });

  it('escalates to destructive above 90% used', () => {
    render(<ContextMeter usage={usage({ usedPercent: 96 })} />);
    expect(screen.getByTestId('context-meter').className).toContain('text-destructive');
  });

  it('renders a fully-consumed window as 100%, not as an error', () => {
    render(<ContextMeter usage={usage({ usedPercent: 100, usedTokens: 1_000_000 })} />);
    expect(screen.getByTestId('context-meter')).toHaveTextContent('100% context used');
  });

  it('renders an untouched window as 0% used', () => {
    render(<ContextMeter usage={usage({ usedPercent: 0, usedTokens: 0 })} />);
    expect(screen.getByTestId('context-meter')).toHaveTextContent('0% context used');
  });
});
