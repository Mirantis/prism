// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { LlmUsageSummary } from '@/types';

const { mockLlmUsage } = vi.hoisted(() => ({ mockLlmUsage: vi.fn() }));
vi.mock('@/api/runtime-client', () => ({ runtimeApi: { llmUsage: mockLlmUsage } }));
vi.mock('@/lib/agent-context', () => ({ useAgent: () => ({ agentId: 'agent-1' }) }));

import { LlmUsageByModel } from './llm-usage-by-model';

function summary(byModel: LlmUsageSummary['byModel']): LlmUsageSummary {
  return {
    windowHours: 24,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    noCacheTokens: 0,
    cacheHitPercent: null,
    calls: 0,
    byModel,
  };
}

function renderTable() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LlmUsageByModel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockLlmUsage.mockReset();
});

describe('LlmUsageByModel', () => {
  it('renders nothing for a window with no model calls', async () => {
    mockLlmUsage.mockResolvedValue(summary([]));

    renderTable();

    await waitFor(() => expect(mockLlmUsage).toHaveBeenCalled());
    expect(screen.queryByTestId('activity-usage-by-model')).not.toBeInTheDocument();
  });

  it('lists each model with its calls and token counts', async () => {
    mockLlmUsage.mockResolvedValue(
      summary([
        { model: 'large-model', calls: 2, totalTokens: 12_400, inputTokens: 12_000, outputTokens: 400 },
        { model: 'small-model', calls: 5, totalTokens: 3_100, inputTokens: 3_000, outputTokens: 100 },
      ]),
    );

    renderTable();

    const rows = await screen.findAllByTestId('activity-model-usage-row');
    expect(rows).toHaveLength(2);
    const cells = within(rows[0]).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['large-model', '2', (12_000).toLocaleString(), '400', (12_400).toLocaleString()]);
    expect(within(rows[1]).getByText('small-model')).toBeInTheDocument();
  });
});
