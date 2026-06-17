// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConversationMessage } from '@/types';

// Capture the onMessage the component hands to useWebSocket so the test can
// drive inbound deliveries. The mock re-captures on every render, so the
// holder always has the latest closure (current activeThreadId) — matching the
// real hook's latest-callback behavior.
const { wsHolder } = vi.hoisted(() => ({ wsHolder: { onMessage: undefined as ((m: ConversationMessage) => void) | undefined } }));

vi.mock('@/hooks/use-websocket', () => ({
  useWebSocket: (opts: { onMessage?: (m: ConversationMessage) => void }) => {
    wsHolder.onMessage = opts.onMessage;
    return { status: 'connected', isTyping: false, sendFollowup: vi.fn(), cancel: vi.fn() };
  },
}));

vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'a1', userId: 'u1', name: 'Prism' }),
}));

const { mockGetThread } = vi.hoisted(() => ({ mockGetThread: vi.fn() }));
vi.mock('@/api/runtime-client', () => ({
  runtimeApi: {
    getThread: mockGetThread,
    getOrCreateLatestThread: vi.fn(),
    uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
  },
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

// Render messages as plain `id:threadId` tokens so the test can assert what's
// on screen without pulling in the full message/markdown renderer.
vi.mock('./ChatMessageList', () => ({
  default: ({ messages }: { messages: ConversationMessage[] }) => (
    <div data-testid="list">{messages.map((m) => `${m.id}:${m.threadId}`).join(',')}</div>
  ),
}));
vi.mock('./ChatInput', () => ({ default: () => <div data-testid="input" /> }));

import AgentChat from './AgentChat';

function msg(id: string, threadId: string): ConversationMessage {
  return {
    id,
    threadId,
    role: 'AGENT',
    content: `content ${id}`,
    triggeredBy: 'USER_INPUT',
    toolCalls: null,
    blocks: null,
    tokenCount: null,
    isCompacted: false,
    createdAt: new Date().toISOString(),
  };
}

describe('AgentChat inbound message scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsHolder.onMessage = undefined;
    // The viewed thread (t1) starts with no history.
    mockGetThread.mockResolvedValue({ id: 't1', messages: [] });
  });

  it('renders only messages for the viewed thread and invalidates by the message thread id', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    render(
      <QueryClientProvider client={qc}>
        <AgentChat threadId="t1" />
      </QueryClientProvider>,
    );

    // Wait for the active thread (t1) to resolve so onMessage closes over it.
    await waitFor(() => expect(mockGetThread).toHaveBeenCalledWith('a1', 'u1', 't1'));
    await waitFor(() => expect(wsHolder.onMessage).toBeTypeOf('function'));

    // A delivery for the viewed thread renders…
    act(() => wsHolder.onMessage!(msg('m1', 't1')));
    await waitFor(() => expect(screen.getByTestId('list').textContent).toContain('m1:t1'));

    // …a delivery for a *different* thread (heartbeat / other tab / Slack) does NOT.
    act(() => wsHolder.onMessage!(msg('m2', 't2')));
    expect(screen.getByTestId('list').textContent).not.toContain('m2:t2');

    // Each delivery invalidates its own thread's cache (not a stale active id).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['thread', 'a1', 't1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['thread', 'a1', 't2'] });

    cleanup();
  });
});
