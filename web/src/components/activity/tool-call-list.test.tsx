// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { ToolCallHistoryEntry, ToolCallHistoryPage } from '@/types';

const { mockListToolCalls } = vi.hoisted(() => ({ mockListToolCalls: vi.fn() }));

vi.mock('@/api/runtime-client', () => ({
  runtimeApi: { listToolCalls: mockListToolCalls },
}));
vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'agent-1', userId: 'user-1', name: 'Test Agent' }),
}));

import { ToolCallList } from './tool-call-list';

type IntersectionCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

/** Every observer currently watching, so a test can see which are live. */
const observers: IntersectionCallback[] = [];

/**
 * A stand-in for IntersectionObserver, so a test can say "the sentinel came
 * into view" whenever it likes rather than waiting on a real layout.
 */
class FakeIntersectionObserver {
  private readonly callback: IntersectionCallback;

  constructor(callback: IntersectionCallback) {
    this.callback = callback;
  }

  observe() {
    observers.push(this.callback);
  }
  disconnect() {
    const at = observers.indexOf(this.callback);
    if (at !== -1) observers.splice(at, 1);
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}

function intersect() {
  // A live observer fires; a disconnected one cannot, which is the whole point.
  // Iterate a copy, since a callback's effect cleanup removes it from the list.
  for (const callback of observers.slice()) callback([{ isIntersecting: true }]);
}

function call(id: string): ToolCallHistoryEntry {
  return {
    id,
    tool: 'shell_exec',
    input: JSON.stringify({ command: `run ${id}` }),
    output: '"ok"',
    success: true,
    timestamp: '2026-08-27T09:00:00.000Z',
    messageId: 'msg-1',
    threadId: 'thread-1',
    threadTitle: 'A thread',
    triggeredBy: 'USER_INPUT',
  };
}

function page(ids: string[], nextCursor: string | null): ToolCallHistoryPage {
  return { items: ids.map(call), nextCursor };
}

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToolCallList />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // reset, not clear: `mockResolvedValueOnce` queues survive clearAllMocks and
  // would leak an unconsumed response into the next test.
  mockListToolCalls.mockReset();
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ToolCallList', () => {
  it('says so when the agent has run no tools', async () => {
    mockListToolCalls.mockResolvedValue(page([], null));

    renderList();

    expect(await screen.findByTestId('activity-tool-calls-empty')).toBeInTheDocument();
  });

  it('reports a failed read rather than calling the history empty', async () => {
    mockListToolCalls.mockRejectedValue(new Error('boom'));

    renderList();

    expect(await screen.findByTestId('activity-tool-calls-error')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-tool-calls-empty')).not.toBeInTheDocument();
  });

  it('lists a page and asks for no more once the cursor runs out', async () => {
    mockListToolCalls.mockResolvedValue(page(['a', 'b'], null));

    renderList();

    await waitFor(() => expect(screen.getAllByTestId('activity-tool-call')).toHaveLength(2));

    // No cursor means no further page, so the sentinel is not even observed.
    expect(observers).toHaveLength(0);
    act(() => intersect());
    await waitFor(() => expect(mockListToolCalls).toHaveBeenCalledTimes(1));
  });

  it('keeps paging when a page comes back empty but carries a cursor', async () => {
    // The service hands back an empty page with a cursor when it hits its batch
    // cap on rows that hold no calls. Showing the empty state there would drop
    // the sentinel and strand every older page.
    mockListToolCalls
      .mockResolvedValueOnce(page([], 'msg-9:0'))
      .mockResolvedValueOnce(page(['a'], null));

    renderList();

    // The empty state must not claim the list is done while a cursor remains,
    // and the sentinel has to be on the page for the next page to load.
    await waitFor(() => expect(observers.length).toBe(1));
    expect(screen.queryByTestId('activity-tool-calls-empty')).not.toBeInTheDocument();

    act(() => intersect());

    await waitFor(() => expect(screen.getAllByTestId('activity-tool-call')).toHaveLength(1));
  });

  it('loads the next page when the sentinel comes into view', async () => {
    mockListToolCalls
      .mockResolvedValueOnce(page(['a'], 'msg-1:0'))
      .mockResolvedValueOnce(page(['b'], null));

    renderList();

    await waitFor(() => expect(screen.getAllByTestId('activity-tool-call')).toHaveLength(1));

    act(() => intersect());

    await waitFor(() => expect(screen.getAllByTestId('activity-tool-call')).toHaveLength(2));
    expect(mockListToolCalls).toHaveBeenLastCalledWith({ limit: 30, cursor: 'msg-1:0' });
  });

  it('stops asking after a next page fails, and offers a retry', async () => {
    // The cursor is still live and the sentinel still visible, so re-observing
    // would retry a failing request for as long as it keeps failing.
    mockListToolCalls
      .mockResolvedValueOnce(page(['a'], 'msg-1:0'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(page(['b'], null));

    renderList();
    await waitFor(() => expect(screen.getAllByTestId('activity-tool-call')).toHaveLength(1));

    act(() => intersect());
    await waitFor(() => expect(mockListToolCalls).toHaveBeenCalledTimes(2));

    // The observer must be gone, so nothing can re-fire it.
    await waitFor(() => expect(observers).toHaveLength(0));
    const retry = await screen.findByTestId('activity-tool-calls-retry');

    act(() => intersect());
    expect(mockListToolCalls).toHaveBeenCalledTimes(2);

    // The already-loaded page stays, and the list does not claim to be complete.
    expect(screen.getAllByTestId('activity-tool-call')).toHaveLength(1);
    expect(screen.queryByText('1 tool call')).not.toBeInTheDocument();

    // Retrying is the way back.
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getAllByTestId('activity-tool-call')).toHaveLength(2));
  });

  it('does not stack requests while a page is already in flight', async () => {
    // The sentinel can stay in view across many observer callbacks; only one
    // next-page request may be outstanding.
    let releaseSecondPage: (value: ToolCallHistoryPage) => void = () => {};
    mockListToolCalls
      .mockResolvedValueOnce(page(['a'], 'msg-1:0'))
      .mockReturnValueOnce(new Promise<ToolCallHistoryPage>((resolve) => {
        releaseSecondPage = resolve;
      }));

    renderList();
    await waitFor(() => expect(screen.getAllByTestId('activity-tool-call')).toHaveLength(1));

    act(() => intersect());
    await waitFor(() => expect(mockListToolCalls).toHaveBeenCalledTimes(2));

    // Fire repeatedly while page two is still pending.
    act(() => intersect());
    act(() => intersect());
    act(() => intersect());

    expect(mockListToolCalls).toHaveBeenCalledTimes(2);

    await act(async () => {
      releaseSecondPage(page(['b'], null));
    });

    await waitFor(() => expect(screen.getAllByTestId('activity-tool-call')).toHaveLength(2));
  });
});
