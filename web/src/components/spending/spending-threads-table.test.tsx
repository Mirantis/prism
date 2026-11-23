// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { ThreadSpend } from '@/types';

const { mockThreads } = vi.hoisted(() => ({ mockThreads: vi.fn() }));

vi.mock('@/api/runtime-client', () => ({ runtimeApi: { spendingThreads: mockThreads } }));
vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'agent-1', userId: 'user-1', name: 'Test Agent' }),
}));

import { SpendingThreadsTable } from './spending-threads-table';

const RANGE = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' };

function thread(n: number): ThreadSpend {
  return {
    threadId: `thread-${n}`,
    title: `Conversation ${n}`,
    requests: 1,
    firstCallAt: RANGE.from,
    lastCallAt: RANGE.from,
    costUsd: 1,
    calls: 1,
    unpricedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

beforeEach(() => {
  mockThreads.mockReset();
});

describe('SpendingThreadsTable', () => {
  it('shows a mention in a title as the name', async () => {
    mockThreads.mockResolvedValue({ threads: [{ ...thread(1), title: '<@U01ET9F2HK4:Ana Lop…' }], nextOffset: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SpendingThreadsTable range={RANGE} total={1} onOpen={() => {}} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('button', { name: 'Ana Lop…' })).toBeInTheDocument();
  });

  it('reads each Show more page from the last page\'s offset, at the same page size', async () => {
    // Far past the route's 200-row limit: every request still asks for one page.
    mockThreads.mockImplementation(async (_range, { limit, offset }: { limit: number; offset: number }) => ({
      threads: Array.from({ length: limit }, (_, i) => thread(offset + i)),
      nextOffset: offset + limit,
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SpendingThreadsTable range={RANGE} total={100} onOpen={() => {}} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getAllByTestId('spending-thread-row')).toHaveLength(20));
    for (let page = 2; page <= 12; page++) {
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      await waitFor(() => expect(screen.getAllByTestId('spending-thread-row')).toHaveLength(page * 20));
    }

    expect(mockThreads.mock.calls.map(([, opts]) => opts)).toEqual(
      Array.from({ length: 12 }, (_, i) => ({ limit: 20, offset: i * 20 })),
    );
    // 240 rows take about 2 s alone and over 4 s beside the rest of the suite.
  }, 15_000);
});
