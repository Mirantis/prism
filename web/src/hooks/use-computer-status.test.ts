// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComputerHelp, ComputerStatus, ComputerSummary } from '@/types';

const { fetchComputerStatus, listComputers } = vi.hoisted(() => ({
  fetchComputerStatus: vi.fn(),
  listComputers: vi.fn(),
}));
vi.mock('@/api/computer', () => ({ fetchComputerStatus, listComputers }));

const { useComputerStatus, useComputerStatusFeed, useCurrentHelp } = await import('./use-computer-status');
const { useComputers } = await import('./use-computers');

const idle: ComputerStatus = {
  available: true,
  running: true,
  starting: false,
  paused: false,
  secure: false,
  controller: null,
  owner: null,
  waiting: [],
  help: [],
};

const help = (id: string, computerId: string | undefined, status: ComputerHelp['status']): ComputerHelp => ({
  type: 'computer_help',
  id,
  reason: 'Sign in',
  status,
  ...(computerId ? { computerId } : {}),
});

const laptop: ComputerSummary = {
  id: 'laptop',
  kind: 'remote',
  name: 'Work laptop',
  connection: 'connected',
  platform: 'macos',
  clientVersion: '1.0.0',
  display: { width: 3024, height: 1964 },
  capabilities: ['screen', 'input'],
  problems: [],
  lastConnectedAt: '2026-10-16T09:00:00.000Z',
  lastSeenAt: '2026-10-16T09:00:00.000Z',
  owner: null,
  controller: null,
};

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => vi.clearAllMocks());

describe('the computer frame', () => {
  it('keeps the runtime’s own help with it, lists the computers, and reads each remote computer again', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchComputerStatus.mockImplementation(async (id: string) => ({
      ...idle,
      computerId: id,
      help: id === 'laptop' ? [help('remote-help', 'laptop', 'waiting')] : [],
    }));
    listComputers.mockResolvedValue({ computers: [] });
    const { result } = renderHook(
      () => ({
        feed: useComputerStatusFeed(),
        local: useComputerStatus(),
        remote: useComputerStatus('laptop'),
        computers: useComputers(),
        current: useCurrentHelp([help('local-help', undefined, 'waiting'), help('remote-help', 'laptop', 'waiting')]),
      }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.remote.data).toBeDefined());
    const remoteReads = fetchComputerStatus.mock.calls.filter(([id]) => id === 'laptop').length;

    act(() =>
      result.current.feed({
        ...idle,
        help: [help('local-help', undefined, 'continued'), help('remote-help', 'laptop', 'waiting')],
        computers: [laptop],
      }),
    );

    await waitFor(() => expect(result.current.local.data?.help).toEqual([help('local-help', undefined, 'continued')]));
    expect(result.current.computers.data).toEqual([laptop]);
    await waitFor(() =>
      expect(fetchComputerStatus.mock.calls.filter(([id]) => id === 'laptop').length).toBe(remoteReads + 1),
    );
    expect(result.current.current.map((item) => item.status)).toEqual(['continued', 'waiting']);
  });

  it('does not read again a computer the frame no longer lists', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchComputerStatus.mockImplementation(async (id: string) => ({ ...idle, computerId: id }));
    const { result } = renderHook(
      () => ({ feed: useComputerStatusFeed(), remote: useComputerStatus('laptop') }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.remote.data).toBeDefined());
    const remoteReads = fetchComputerStatus.mock.calls.filter(([id]) => id === 'laptop').length;

    act(() => result.current.feed({ ...idle, help: [], computers: [] }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchComputerStatus.mock.calls.filter(([id]) => id === 'laptop').length).toBe(remoteReads);
  });

  it('shows a removed computer’s request as the frame reports it, once it is dismissed', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const asked = help('remote-help', 'laptop', 'waiting');
    fetchComputerStatus.mockImplementation(async (id: string) => ({ ...idle, computerId: id, help: [asked] }));
    const { result } = renderHook(
      () => ({
        feed: useComputerStatusFeed(),
        remote: useComputerStatus('laptop'),
        current: useCurrentHelp([asked]),
      }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.current[0].status).toBe('waiting'));
    // The computer is removed, and a read of it answers 404 from here on.
    fetchComputerStatus.mockRejectedValue(new Error('Computer not found'));
    act(() => result.current.feed({ ...idle, help: [asked], computers: [] }));

    act(() => result.current.feed({ ...idle, help: [{ ...asked, status: 'dismissed' }], computers: [] }));

    await waitFor(() => expect(result.current.current[0].status).toBe('dismissed'));
    expect(result.current.remote.data?.help).toEqual([{ ...asked, status: 'dismissed' }]);
  });
});
