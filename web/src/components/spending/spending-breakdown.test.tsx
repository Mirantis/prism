// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { SpendBreakdown, SpendTotals } from '@/types';

const { mockSources } = vi.hoisted(() => ({ mockSources: vi.fn() }));

vi.mock('@/api/runtime-client', () => ({ runtimeApi: { spendingSources: mockSources } }));
vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'agent-1', userId: 'user-1', name: 'Test Agent' }),
}));

import { SpendingBreakdown } from './spending-breakdown';

function totals(costUsd: number, unpricedCalls = 0): SpendTotals {
  return { costUsd, calls: 4, unpricedCalls, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

const SUMMARY: SpendBreakdown = {
  ...totals(10, 2),
  byKind: [],
  byCategory: [
    { category: 'conversations', ...totals(6) },
    { category: 'scheduled-tasks', ...totals(3) },
    { category: 'background', ...totals(1) },
  ],
  byModel: [{ model: 'global.anthropic.claude-opus-5-5', ...totals(10) }],
  byPurpose: [],
};

const RANGE = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' };

function renderBreakdown() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SpendingBreakdown summary={SUMMARY} range={RANGE} isLoading={false} />
    </QueryClientProvider>,
  );
}

beforeEach(() => mockSources.mockReset());

describe('SpendingBreakdown', () => {
  it('ranks the categories with their share, and opens scheduled tasks into one row per task', async () => {
    mockSources.mockResolvedValue({
      sources: [
        { sourceId: 'task-1', name: 'Nightly CI digest', ...totals(2.5) },
        { sourceId: 'gone', name: null, ...totals(0.5) },
      ],
    });
    renderBreakdown();

    const rows = screen.getAllByTestId('spending-breakdown-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Conversations60%$6.00',
      'Scheduled tasks30%$3.00',
      'Background work10%$1.00',
    ]);
    expect(mockSources).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Scheduled tasks'));

    await waitFor(() => expect(screen.getAllByTestId('spending-source')).toHaveLength(2));
    expect(mockSources).toHaveBeenCalledWith('scheduled-tasks', RANGE);
    expect(screen.getByText('Nightly CI digest')).toBeInTheDocument();
    expect(screen.getByText('Deleted task')).toBeInTheDocument();
  });

  it('lists models by their short name, and says the total leaves out the unpriced calls', () => {
    renderBreakdown();

    fireEvent.click(screen.getByRole('tab', { name: 'By model' }));

    expect(screen.getByText('claude-opus-5-5')).toHaveAttribute('title', 'global.anthropic.claude-opus-5-5');
    expect(screen.getByTestId('spending-unpriced-note')).toHaveTextContent('2 model calls in this range have no price');
  });
});
