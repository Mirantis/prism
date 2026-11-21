// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SpendingChart } from './spending-chart';
import type { PeriodSpend } from '@/types';

function period(start: string, main: number, codingAgent = 0, unpricedCalls = 0): PeriodSpend {
  return {
    start,
    from: '',
    to: '',
    costUsd: main + codingAgent,
    calls: 3,
    unpricedCalls,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsdByKind: { main, 'coding-agent': codingAgent, voice: 0 },
  };
}

const PERIODS = [period('2026-11-17', 1.2), period('2026-11-18', 2.13, 0.86, 1), period('2026-11-19', 0)];

describe('SpendingChart', () => {
  it('names each bar with its date and total, and selects or clears a period on click', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<SpendingChart periods={PERIODS} length="day" selected={null} onSelect={onSelect} />);

    const bar = screen.getByRole('button', { name: 'Wed, Nov 18: $2.99' });
    fireEvent.click(bar);
    expect(onSelect).toHaveBeenLastCalledWith('2026-11-18');

    rerender(<SpendingChart periods={PERIODS} length="day" selected="2026-11-18" onSelect={onSelect} />);
    expect(bar).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(bar);
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("shows a period's kinds and its unpriced calls on hover, and leaves out a kind with nothing", () => {
    render(<SpendingChart periods={PERIODS} length="day" selected={null} onSelect={vi.fn()} />);

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Wed, Nov 18: $2.99' }));

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Agent$2.13');
    expect(tooltip).toHaveTextContent('Coding agent$0.86');
    expect(tooltip).not.toHaveTextContent('Voice');
    expect(tooltip).toHaveTextContent('1 call with no price');
  });

  it('says so when nothing was spent in the periods shown', () => {
    render(<SpendingChart periods={[period('2026-11-18', 0)]} length="day" selected={null} onSelect={vi.fn()} />);

    expect(screen.getByText('Nothing spent in these 1 days.')).toBeInTheDocument();
  });
});
