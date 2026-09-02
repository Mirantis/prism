// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConversationMessage } from '@/types';

// Capture the onMessage the component hands to useWebSocket so the test can
// drive inbound deliveries. The mock re-captures on every render, so the
// holder always has the latest closure (current activeThreadId) — matching the
// real hook's latest-callback behavior.
// `isTyping` and `sendFollowup` live on the holder too: the mock body runs on
// every render, so a `vi.fn()` created inline would be a fresh spy each time
// and could never be asserted against.
const { wsHolder } = vi.hoisted(() => ({
  wsHolder: {
    onMessage: undefined as ((m: ConversationMessage) => void) | undefined,
    onVoice: undefined as ((f: unknown) => void) | undefined,
    isTyping: false,
    sendFollowup: vi.fn(),
    sendVoiceOffer: vi.fn(),
    sendVoiceIce: vi.fn(),
    sendVoiceStop: vi.fn(),
  },
}));

vi.mock('@/hooks/use-websocket', () => ({
  useWebSocket: (opts: { onMessage?: (m: ConversationMessage) => void; onVoice?: (f: unknown) => void }) => {
    wsHolder.onMessage = opts.onMessage;
    wsHolder.onVoice = opts.onVoice;
    return {
      status: 'connected',
      isTyping: wsHolder.isTyping,
      sendFollowup: wsHolder.sendFollowup,
      cancel: vi.fn(),
      sendVoiceOffer: wsHolder.sendVoiceOffer,
      sendVoiceIce: wsHolder.sendVoiceIce,
      sendVoiceStop: wsHolder.sendVoiceStop,
    };
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
    <>
      <div data-testid="list">{messages.map((m) => `${m.id}:${m.threadId}`).join(',')}</div>
      <div data-testid="contents">{messages.map((m) => m.content).join('|')}</div>
    </>
  ),
}));
// Composer stub: enough of the real contract (controlled value + a submit
// trigger) to drive AgentChat's send path without the full input component.
vi.mock('./ChatInput', () => ({
  default: ({
    value,
    onChange,
    onSend,
    voiceState,
    onVoiceStart,
    onVoiceStop,
  }: {
    value: string;
    onChange: (v: string) => void;
    onSend: (e: { preventDefault: () => void }) => void;
    voiceState: string;
    onVoiceStart: () => void;
    onVoiceStop: () => void;
  }) => (
    <div data-testid="input">
      <input data-testid="composer" value={value} onChange={(e) => onChange(e.target.value)} />
      <button data-testid="send" onClick={() => onSend({ preventDefault: () => {} })}>
        send
      </button>
      <span data-testid="voice-state">{voiceState}</span>
      <button data-testid="voice-start" onClick={onVoiceStart}>
        start
      </button>
      <button data-testid="voice-stop" onClick={onVoiceStop}>
        stop
      </button>
    </div>
  ),
}));

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
    wsHolder.isTyping = false;
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

/** Just enough of the browser's audio machinery for a call to be started here. */
class FakePC {
  localDescription = { type: 'offer', sdp: 'v=0\r\noffer' };
  connectionState = 'new';
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  addTrack() {}
  async createOffer() {
    return this.localDescription;
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {}
}

describe('AgentChat voice chat', () => {
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: () => {} }] }));

  beforeEach(() => {
    vi.clearAllMocks();
    wsHolder.onVoice = undefined;
    wsHolder.isTyping = false;
    mockGetThread.mockResolvedValue({ id: 't1', messages: [] });
    getUserMedia.mockImplementation(async () => ({ getTracks: () => [{ stop: () => {} }] }));
    vi.stubGlobal('RTCPeerConnection', FakePC);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  async function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AgentChat threadId="t1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(mockGetThread).toHaveBeenCalledWith('a1', 'u1', 't1'));
    await waitFor(() => expect(wsHolder.onVoice).toBeTypeOf('function'));
  }

  function contents() {
    return screen.getByTestId('contents').textContent ?? '';
  }

  // Every refusal the runtime writes is shown word for word: docs/voice-chat.md writes
  // that text for the user, so re-wording it here would make its error table fiction.
  it.each([
    'There is already a voice chat running. End that one first.',
    "I'm in a meeting call right now. That has to end before I can talk here.",
    'Could not start the voice chat: the model session would not open',
    'This build cannot carry a voice chat — its WebRTC support is missing.',
  ])('shows the refusal "%s" as a line in the conversation', async (error) => {
    await mount();

    act(() => wsHolder.onVoice!({ kind: 'error', error }));

    await waitFor(() => expect(contents()).toContain(error));
  });

  it('reports a denied microphone itself, which the runtime never sees', async () => {
    getUserMedia.mockRejectedValue(new Error('NotAllowedError'));
    await mount();

    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-start'));
    });

    await waitFor(() => expect(contents()).toContain('Voice chat needs your microphone'));
    expect(wsHolder.sendVoiceOffer).not.toHaveBeenCalled();
  });

  it('adds nothing to the conversation for a call that runs and ends', async () => {
    // Criterion: the interface must not imply a transcript exists. A call that ends
    // normally leaves no line at all, so nothing on screen reads as a message that
    // failed to arrive.
    await mount();
    const before = contents();

    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-start'));
    });
    expect(wsHolder.sendVoiceOffer).toHaveBeenCalledWith('v=0\r\noffer', 't1');

    await act(async () => {
      wsHolder.onVoice!({ kind: 'answer', sdp: 'v=0\r\nanswer' });
    });
    act(() => wsHolder.onVoice!({ kind: 'state', state: 'live' }));
    await waitFor(() => expect(screen.getByTestId('voice-state').textContent).toBe('live'));

    act(() => fireEvent.click(screen.getByTestId('voice-stop')));
    expect(wsHolder.sendVoiceStop).toHaveBeenCalledTimes(1);
    act(() => wsHolder.onVoice!({ kind: 'state', state: 'ended' }));

    await waitFor(() => expect(screen.getByTestId('voice-state').textContent).toBe('idle'));
    expect(contents()).toBe(before);
  });
});

describe('AgentChat mid-turn send (steering)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsHolder.onMessage = undefined;
    mockGetThread.mockResolvedValue({ id: 't1', messages: [] });
  });

  it('sends while a turn is in flight, carrying the active thread id', async () => {
    // The thread id is the whole point: the gateway only offers a message to a
    // live turn when it carries one, otherwise the message queues and is
    // answered late instead of steering.
    wsHolder.isTyping = true;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <AgentChat threadId="t1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(mockGetThread).toHaveBeenCalledWith('a1', 'u1', 't1'));

    fireEvent.change(screen.getByTestId('composer'), { target: { value: 'change of plan' } });
    fireEvent.click(screen.getByTestId('send'));

    expect(wsHolder.sendFollowup).toHaveBeenCalledWith('change of plan', 'a1', 't1', []);
    // The optimistic echo renders immediately, as it does for an idle send.
    await waitFor(() => expect(screen.getByTestId('list').textContent).toContain(':t1'));

    cleanup();
  });
});
