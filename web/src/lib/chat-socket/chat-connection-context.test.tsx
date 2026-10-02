// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useChatSocket } from '@/hooks/use-chat-socket';
import { useComputerVoice } from '@/hooks/use-computer-voice';
import { UpdateRequiredBanner } from '@/components/layout/update-required-banner';
import type { ConversationThread } from '@lensapp/prism-client';
import { ChatConnectionProvider } from './chat-connection-context';
import { FakeWebSocket, welcomeFrame } from '@lensapp/prism-client/testing';

vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'a1', userId: 'u1', name: 'Prism' }),
}));
vi.mock('@/api/runtime-client', () => ({ webSocketUrl: () => 'ws://test/api/ws' }));
vi.mock('@/lib/voice-audio', () => ({ VOICE_SAMPLE_RATE: 24_000, startVoiceAudio: vi.fn() }));

/** What the presence mark reads: whether any thread is working. */
function Presence() {
  const { turns } = useChatSocket();
  return <span data-testid="presence">{Object.keys(turns).length > 0 ? 'busy' : 'idle'}</span>;
}

function ComputerCall() {
  const call = useComputerVoice();
  return <span data-testid="call">{call.status}</span>;
}

describe('ChatConnectionProvider', () => {
  let qc: QueryClient;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    qc = new QueryClient();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderTab() {
    render(
      <QueryClientProvider client={qc}>
        <ChatConnectionProvider>
          <UpdateRequiredBanner />
          <Presence />
          <ComputerCall />
        </ChatConnectionProvider>
      </QueryClientProvider>,
    );
    const ws = FakeWebSocket.latest();
    act(() => {
      ws.open();
      ws.deliver(welcomeFrame());
    });
    return ws;
  }

  it('opens one socket for every surface of the tab', async () => {
    const ws = renderTab();

    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => ws.deliver({ type: 'turn', seq: 1, payload: { threadId: 't1', state: 'running' } }));
    await waitFor(() => expect(screen.getByTestId('presence').textContent).toBe('busy'));
    expect(screen.getByTestId('call').textContent).toBe('idle');
  });

  it('lists a thread created elsewhere and follows its new title', async () => {
    qc.setQueryData<ConversationThread[]>(['threads', 'a1', 'recents'], []);
    const ws = renderTab();

    act(() => {
      ws.deliver({
        type: 'thread',
        seq: 1,
        payload: { threadId: 't9', title: null, createdAt: '2026-09-27T08:38:51.086Z' },
      });
      ws.deliver({ type: 'thread', seq: 2, payload: { threadId: 't9', title: 'Staging pods' } });
      // A title for a thread the list does not hold adds nothing.
      ws.deliver({ type: 'thread', seq: 3, payload: { threadId: 'slack-thread', title: 'Elsewhere' } });
    });

    const recents = () => qc.getQueryData<ConversationThread[]>(['threads', 'a1', 'recents']);
    await waitFor(() => expect(recents()?.map((t) => [t.id, t.title])).toEqual([['t9', 'Staging pods']]));
  });

  it('asks for a reload, and stops reconnecting, when the runtime needs a newer page', () => {
    vi.useFakeTimers();
    try {
      const ws = renderTab();
      expect(screen.queryByTestId('update-required-banner')).toBeNull();

      act(() => ws.serverClose(4426));
      expect(screen.getByTestId('update-required-banner').textContent).toContain('Reload this page');

      act(() => vi.advanceTimersByTime(10 * 60_000));
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
