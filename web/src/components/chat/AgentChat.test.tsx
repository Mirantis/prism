// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComputerStatus, ConversationMessage } from '@/types';
import type { Dictation } from '@/hooks/use-dictation';
import type { DictationEvent } from '@/hooks/use-websocket';

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
    // The dictation frames arrive on the same socket, and the component routes them to
    // the dictation through a ref. Captured here so a test can deliver one.
    onDictationEvent: undefined as ((e: unknown) => void) | undefined,
    // The state of the desktop arrives on the same socket. Captured so a test can
    // deliver one without a runtime.
    onComputerStatus: undefined as ((s: ComputerStatus) => void) | undefined,
    isTyping: false,
    sendFollowup: vi.fn(),
    sendVoiceAudio: vi.fn(),
    sendDictationStart: vi.fn(() => true),
    sendDictationStop: vi.fn(),
  },
}));

vi.mock('@/hooks/use-websocket', () => ({
  useWebSocket: (opts: {
    onMessage?: (m: ConversationMessage) => void;
    onDictationEvent?: (e: unknown) => void;
    onComputerStatus?: (s: ComputerStatus) => void;
  }) => {
    wsHolder.onMessage = opts.onMessage;
    wsHolder.onDictationEvent = opts.onDictationEvent;
    wsHolder.onComputerStatus = opts.onComputerStatus;
    return {
      status: 'connected',
      isTyping: wsHolder.isTyping,
      sendFollowup: wsHolder.sendFollowup,
      cancel: vi.fn(),
      sendVoiceAudio: wsHolder.sendVoiceAudio,
      sendDictationStart: wsHolder.sendDictationStart,
      sendDictationStop: wsHolder.sendDictationStop,
    };
  },
}));

// The microphone. The hook's `onFrame` is kept so a test can speak into it.
const { voiceAudio, microphone } = vi.hoisted(() => ({
  voiceAudio: { enqueue: vi.fn(), clear: vi.fn(), stop: vi.fn(async () => {}) },
  microphone: { onFrame: undefined as ((f: ArrayBuffer) => void) | undefined },
}));
vi.mock('@/lib/voice-audio', () => ({
  VOICE_SAMPLE_RATE: 24_000,
  startVoiceAudio: async (opts: { onFrame: (f: ArrayBuffer) => void }) => {
    microphone.onFrame = opts.onFrame;
    return voiceAudio;
  },
}));

// A computer-enabled agent, which is what puts the waiting banner's query on the page.
vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'a1', userId: 'u1', name: 'Prism', hasComputer: true }),
}));

/** A desktop nobody is using. */
const idleComputer: ComputerStatus = {
  available: true,
  running: false,
  starting: false,
  paused: false,
  controller: null,
  owner: null,
  waiting: [],
  help: [],
};

const { mockComputerRequest } = vi.hoisted(() => ({
  mockComputerRequest: vi.fn(async () => ({
    available: true,
    running: false,
    starting: false,
    paused: false,
    controller: null,
    owner: null,
    waiting: [],
    help: [],
  })),
}));
vi.mock('@/api/computer', () => ({ computerRequest: mockComputerRequest }));

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
// Composer stub: enough of the real contract (controlled value + a submit
// trigger) to drive AgentChat's send path without the full input component.
vi.mock('./ChatInput', () => ({
  default: ({
    value,
    onChange,
    onSend,
    dictation,
  }: {
    value: string;
    onChange: (v: string) => void;
    onSend: (e: { preventDefault: () => void }) => void;
    dictation?: Dictation;
  }) => (
    <div data-testid="input">
      <input data-testid="composer" value={value} onChange={(e) => onChange(e.target.value)} />
      <button data-testid="send" onClick={() => onSend({ preventDefault: () => {} })}>
        send
      </button>
      <span data-testid="dictation-status">{dictation?.status}</span>
      <button data-testid="dictation-start" onClick={() => dictation?.start()}>
        dictate
      </button>
      <button data-testid="dictation-send" onClick={() => dictation?.send()}>
        send
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

describe('AgentChat computer state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsHolder.onComputerStatus = undefined;
    wsHolder.isTyping = false;
    mockGetThread.mockResolvedValue({ id: 't1', messages: [] });
  });

  function renderChat() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <AgentChat threadId="t1" />
      </QueryClientProvider>,
    );
  }

  it('asks the runtime for the desktop state once and then waits for the socket', async () => {
    vi.useFakeTimers();
    try {
      renderChat();

      await vi.waitFor(() => expect(mockComputerRequest).toHaveBeenCalledTimes(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });

      // Three times over the old two-second interval, and still one request.
      expect(mockComputerRequest).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });

  it('raises the waiting banner from a frame for the viewed thread, and for no other', async () => {
    try {
      renderChat();
      await waitFor(() => expect(wsHolder.onComputerStatus).toBeTypeOf('function'));

      act(() =>
        wsHolder.onComputerStatus!({
          ...idleComputer,
          running: true,
          waiting: [{ id: 'use-1', threadId: 't1', mode: 'cron' }],
        }),
      );
      // A cron turn queued for the desktop: the frame reports the wait whichever
      // caller is in it.
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toContain('Waiting for the computer'),
      );

      act(() =>
        wsHolder.onComputerStatus!({
          ...idleComputer,
          running: true,
          waiting: [{ id: 'use-2', threadId: 't2', mode: 'chat' }],
        }),
      );
      await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    } finally {
      cleanup();
    }
  });
});

describe('AgentChat dictation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsHolder.isTyping = false;
    wsHolder.sendDictationStart.mockReturnValue(true);
    mockGetThread.mockResolvedValue({ id: 't1', messages: [] });
  });

  it('sends the transcript as the user message on the thread being viewed', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <AgentChat threadId="t1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(mockGetThread).toHaveBeenCalledWith('a1', 'u1', 't1'));

    fireEvent.click(screen.getByTestId('dictation-start'));
    await waitFor(() => expect(screen.getByTestId('dictation-status').textContent).toBe('recording'));
    expect(wsHolder.sendDictationStart).toHaveBeenCalledTimes(1);

    // The microphone rides the socket as binary frames.
    const frame = new Int16Array([7, 8]).buffer;
    act(() => microphone.onFrame!(frame));
    expect(wsHolder.sendVoiceAudio).toHaveBeenCalledWith(frame);

    fireEvent.click(screen.getByTestId('dictation-send'));
    expect(wsHolder.sendDictationStop).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('dictation-status').textContent).toBe('transcribing');

    act(() =>
      wsHolder.onDictationEvent!({ type: 'result', text: ' Check the staging pods. ' } satisfies DictationEvent),
    );
    expect(wsHolder.sendFollowup).toHaveBeenCalledWith('Check the staging pods.', 'a1', 't1', []);
    // Echoed on the thread at once, as a typed message is.
    expect(screen.getByTestId('list').textContent).toMatch(/temp-\d+:t1/);
    expect(screen.getByTestId('dictation-status').textContent).toBe('idle');

    cleanup();
  });
});
