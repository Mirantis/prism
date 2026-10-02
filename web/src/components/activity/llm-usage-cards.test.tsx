// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { LlmUsageSummary } from '@lensapp/prism-client';

const { mockLlmUsage } = vi.hoisted(() => ({ mockLlmUsage: vi.fn() }));

vi.mock('@/api/runtime-client', () => ({
  runtimeApi: { llmUsage: mockLlmUsage },
}));
vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'agent-1', userId: 'user-1', name: 'Test Agent' }),
}));

import { LlmUsageCards } from './llm-usage-cards';

function summary(over: Partial<LlmUsageSummary> = {}): LlmUsageSummary {
  return {
    windowHours: 24,
    totalTokens: 1_234_567,
    inputTokens: 1_230_000,
    outputTokens: 4_567,
    cacheReadTokens: 900_000,
    cacheWriteTokens: 300_000,
    noCacheTokens: 30_000,
    cacheHitPercent: 73,
    calls: 12,
    ...over,
  };
}

function renderCards() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LlmUsageCards />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockLlmUsage.mockReset();
});

afterEach(cleanup);

describe('LlmUsageCards', () => {
  it('abbreviates each total and shows the exact count as visible text', async () => {
    // Visible, not a `title`: a tooltip on a non-focusable element reaches
    // neither a keyboard nor a touchscreen.
    mockLlmUsage.mockResolvedValue(summary());

    renderCards();

    await waitFor(() => expect(screen.getByTestId('activity-total-tokens')).toHaveTextContent('1.23M'));
    expect(screen.getByTestId('activity-input-tokens')).toHaveTextContent('1.23M');
    expect(screen.getByTestId('activity-output-tokens')).toHaveTextContent('4.6K');

    expect(screen.getByText('1,234,567 across 12 model calls')).toBeInTheDocument();
    expect(screen.getByText('1,230,000 tokens, cache included')).toBeInTheDocument();
    expect(screen.getByText('4,567 tokens generated')).toBeInTheDocument();

    // Nothing depends on a hover-only attribute any more.
    expect(screen.getByTestId('activity-total-tokens')).not.toHaveAttribute('title');
  });

  it('reads the window as 24 hours', async () => {
    mockLlmUsage.mockResolvedValue(summary());

    renderCards();

    await waitFor(() => expect(mockLlmUsage).toHaveBeenCalledWith(24));
  });

  it('shows a cache rate and what it was read from', async () => {
    mockLlmUsage.mockResolvedValue(summary());

    renderCards();

    await waitFor(() => expect(screen.getByTestId('activity-cache-hit-rate')).toHaveTextContent('73%'));
    // The exact figures, and the denominator the rate is taken against.
    expect(screen.getByText('900,000 of 1,230,000 read from cache')).toBeInTheDocument();
  });

  it('shows a real zero rate rather than hiding it', async () => {
    // A model that does no prompt caching reports its whole prompt uncached,
    // which is a measured 0% and not an absent measurement.
    mockLlmUsage.mockResolvedValue(
      summary({ cacheHitPercent: 0, cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 1_230_000 }),
    );

    renderCards();

    await waitFor(() => expect(screen.getByTestId('activity-cache-hit-rate')).toHaveTextContent('0%'));
  });

  it('dashes the cache rate when the provider reported no breakdown', async () => {
    mockLlmUsage.mockResolvedValue(summary({ cacheHitPercent: null }));

    renderCards();

    await waitFor(() => expect(screen.getByTestId('activity-cache-hit-rate')).toHaveTextContent('—'));
    expect(screen.getByText('Not reported by this provider')).toBeInTheDocument();
  });

  it('says the figures could not be read when the request fails', async () => {
    // Not a permanent skeleton, and not a zero: both would misreport a failure.
    mockLlmUsage.mockRejectedValue(new Error('boom'));

    renderCards();

    await waitFor(() => expect(screen.getByTestId('activity-total-tokens')).toHaveTextContent('—'));
    expect(screen.getByTestId('activity-input-tokens')).toHaveTextContent('—');
    expect(screen.getByTestId('activity-output-tokens')).toHaveTextContent('—');
    expect(screen.getByTestId('activity-cache-hit-rate')).toHaveTextContent('—');

    // And it must not blame the provider for a read that never landed, nor
    // report an unavailable figure as a measured zero.
    expect(screen.queryByText('Not reported by this provider')).not.toBeInTheDocument();
    expect(screen.getAllByText('Could not be read')).toHaveLength(4);
    expect(screen.queryByText(/^0 /)).not.toBeInTheDocument();
  });

  it('shows no figures at all while the first read is outstanding', () => {
    mockLlmUsage.mockReturnValue(new Promise(() => {}));

    renderCards();

    expect(screen.queryByTestId('activity-total-tokens')).not.toBeInTheDocument();
  });
});
