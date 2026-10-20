// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ComputerStatus, ConversationMessage } from '@/types';
import type { Dictation } from '@/hooks/use-dictation';
import type { TranscriptMessage } from '@/lib/chat-socket/transcript';
import { ChatConnectionProvider } from '@/lib/chat-socket/chat-connection-context';
import { FakeWebSocket, welcomeFrame } from '@/lib/chat-socket/fake-web-socket';
import { HeaderActionsProvider } from '@/lib/header-actions-context';
import { HeaderActionsSlot } from '@/components/layout/header-actions-slot';
import { ApiError } from '@/api/errors';

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

vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'a1', userId: 'u1', name: 'Prism', hasComputer: true }),
}));

/** A desktop nobody is using. */
const idleComputer: ComputerStatus = {
  available: true,
  running: false,
  starting: false,
  paused: false,
  secure: false,
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
vi.mock('@/api/computer', () => ({
  computerRequest: mockComputerRequest,
  fetchComputerStatus: mockComputerRequest,
  computerAction: vi.fn(),
  // The runtime's own computer, which the waiting banner reads the state of.
  listComputers: async () => ({
    computers: [
      {
        id: 'local',
        kind: 'local',
        name: 'This runtime',
        connection: 'connected',
        platform: 'linux',
        clientVersion: null,
        display: { width: 1920, height: 1080 },
        capabilities: [],
        problems: [],
        lastConnectedAt: null,
        lastSeenAt: null,
        owner: null,
        controller: null,
      },
    ],
  }),
}));

const { mockGetThread, mockLatestThread } = vi.hoisted(() => ({
  mockGetThread: vi.fn(),
  mockLatestThread: vi.fn(),
}));
vi.mock('@/api/runtime-client', () => ({
  runtimeApi: {
    getThread: mockGetThread,
    getOrCreateLatestThread: mockLatestThread,
    uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
  },
  webSocketUrl: () => 'ws://test/api/ws',
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

// Render messages as plain `id:threadId[:delivery]` tokens so the test can assert what's
// on screen without pulling in the full message/markdown renderer.
vi.mock('./ChatMessageList', () => ({
  default: ({
    messages,
    turnState,
    onRetry,
    onEdit,
  }: {
    messages: TranscriptMessage[];
    turnState: string;
    onRetry: (id: string) => void;
    onEdit: (id: string) => void;
  }) => (
    <div data-testid="list" data-turn={turnState}>
      <span data-testid="rows">
        {messages.map((m) => [m.id, m.threadId, m.delivery].filter(Boolean).join(':')).join(',')}
      </span>
      {messages
        .filter((m) => m.delivery === 'failed')
        .map((m) => (
          <span key={m.id}>
            <button data-testid="retry" onClick={() => onRetry(m.id)}>
              {m.deliveryError}
            </button>
            <button data-testid="edit" onClick={() => onEdit(m.id)}>
              edit
            </button>
          </span>
        ))}
    </div>
  ),
}));
// Composer stub: enough of the real contract (controlled value, a submit trigger, the
// STOP button) to drive AgentChat without the full input component.
vi.mock('./ChatInput', () => ({
  default: ({
    value,
    onChange,
    onSend,
    isPending,
    onCancel,
    connectionStatus,
    dictation,
    dictationBlockedReason,
  }: {
    value: string;
    onChange: (v: string) => void;
    onSend: (e: { preventDefault: () => void }) => void;
    isPending: boolean;
    onCancel: () => void;
    connectionStatus: string;
    dictation?: Dictation;
    dictationBlockedReason?: string | null;
  }) => (
    <div data-testid="input" data-pending={String(isPending)} data-status={connectionStatus}>
      <input data-testid="composer" value={value} onChange={(e) => onChange(e.target.value)} />
      <button data-testid="send" onClick={() => onSend({ preventDefault: () => {} })}>
        send
      </button>
      {isPending && (
        <button data-testid="stop" onClick={onCancel}>
          stop
        </button>
      )}
      <span data-testid="dictation-status">{dictation?.status}</span>
      <span data-testid="dictation-blocked">{dictationBlockedReason ?? ''}</span>
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

function msg(id: string, threadId: string, createdAt = new Date().toISOString()): ConversationMessage {
  return {
    id,
    threadId,
    role: 'AGENT',
    content: `content ${id}`,
    triggeredBy: 'USER_INPUT',
    toolCalls: null,
    blocks: null,
    isCompacted: false,
    createdAt,
    attachments: null,
    senderName: null,
  };
}

const list = () => screen.getByTestId('list');
const rows = () => (screen.getByTestId('rows').textContent ?? '').split(',').filter(Boolean);

describe('AgentChat', () => {
  let seq = 0;
  let ws: FakeWebSocket;
  let qc: QueryClient;
  /** Deliver one stream event, numbered after the last. */
  const event = (type: string, payload: object) => act(() => ws.deliver({ type, seq: ++seq, payload }));

  beforeEach(() => {
    vi.clearAllMocks();
    seq = 0;
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    mockGetThread.mockResolvedValue({ id: 't1', messages: [] });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Render the chat on the tab's socket, and let the runtime welcome it. */
  async function renderChat(ui: ReactNode = <AgentChat threadId="t1" />) {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ChatConnectionProvider>
          <HeaderActionsProvider>
            <HeaderActionsSlot />
            {ui}
          </HeaderActionsProvider>
        </ChatConnectionProvider>
      </QueryClientProvider>,
    );
    ws = FakeWebSocket.latest();
    act(() => {
      ws.open();
      ws.deliver(welcomeFrame());
    });
    // The welcome's reload holds the stream until it is done.
    await waitFor(() => expect(mockGetThread).toHaveBeenCalled());
  }

  const sentFrames = (type: string) => ws.frames.filter((f) => f.type === type);

  it('shows the viewed thread from the stream without reloading it for each message', async () => {
    await renderChat();
    await waitFor(() => expect(qc.getQueryData(['thread', 'a1', 't1'])).toBeDefined());
    const loads = mockGetThread.mock.calls.length;

    event('message', msg('m1', 't1'));
    event('message', msg('m2', 't2'));

    await waitFor(() => expect(rows()).toEqual(['m1:t1']));
    expect(mockGetThread).toHaveBeenCalledTimes(loads);
  });

  it('orders the thread by time and keeps an unsent message last until its copy arrives', async () => {
    mockGetThread.mockResolvedValue({
      id: 't1',
      messages: [msg('a', 't1', '2026-09-27T10:00:00.000Z'), msg('c', 't1', '2026-09-27T10:02:00.000Z')],
    });
    await renderChat();
    await waitFor(() => expect(rows()).toEqual(['a:t1', 'c:t1']));

    event('message', msg('b', 't1', '2026-09-27T10:01:00.000Z'));
    await waitFor(() => expect(rows()).toEqual(['a:t1', 'b:t1', 'c:t1']));

    fireEvent.change(screen.getByTestId('composer'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('send'));
    const sent = sentFrames('send')[0]!.payload.message;
    expect(sent).toMatchObject({ threadId: 't1', content: 'hello', attachmentIds: [] });
    expect(rows()).toEqual(['a:t1', 'b:t1', 'c:t1', `${sent.id}:t1:sending`]);

    // The stored copy has the runtime's clock, and takes its place by it.
    event('message', { ...msg(sent.id, 't1', '2026-09-27T10:01:30.000Z'), role: 'USER', content: 'hello' });
    await waitFor(() => expect(rows()).toEqual(['a:t1', 'b:t1', `${sent.id}:t1`, 'c:t1']));
  });

  it('shows STOP while the thread on screen is queued or running, and stops it', async () => {
    await renderChat();
    expect(screen.getByTestId('input').dataset.pending).toBe('false');

    event('turn', { threadId: 't2', state: 'running' });
    event('turn', { threadId: 't1', state: 'queued' });
    await waitFor(() => expect(list().dataset.turn).toBe('queued'));
    expect(screen.getByTestId('input').dataset.pending).toBe('true');

    event('turn', { threadId: 't1', state: 'running' });
    await waitFor(() => expect(list().dataset.turn).toBe('running'));

    fireEvent.click(screen.getByTestId('stop'));
    expect(sentFrames('cancel')).toEqual([{ type: 'cancel', id: expect.any(String), payload: { threadId: 't1' } }]);
    expect(rows().some((r) => r.startsWith('stopped-'))).toBe(true);

    event('turn', { threadId: 't1', state: 'idle', outcome: 'cancelled' });
    await waitFor(() => expect(screen.getByTestId('input').dataset.pending).toBe('false'));
  });

  it("says why a turn failed, in the thread it failed on", async () => {
    await renderChat();
    event('turn', { threadId: 't1', state: 'running' });
    event('turn', { threadId: 't1', state: 'idle', outcome: 'failed', error: 'The model is unavailable.' });

    await waitFor(() => expect(rows().some((r) => r.startsWith('error-'))).toBe(true));
  });

  it('marks a refused message failed and sends it again on retry', async () => {
    await renderChat();
    fireEvent.change(screen.getByTestId('composer'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('send'));
    const first = sentFrames('send')[0]!;

    act(() => ws.deliver({ type: 'nack', re: first.id, payload: { code: 'unavailable', message: 'starting' } }));
    expect(rows()).toEqual([`${first.payload.message.id}:t1:failed`]);
    expect(screen.getByTestId('retry').textContent).toBe('The agent is still starting.');

    fireEvent.click(screen.getByTestId('retry'));
    const retried = sentFrames('send')[1]!.payload.message;
    expect(retried.content).toBe('hello');
    expect(rows()).toEqual([`${retried.id}:t1:sending`]);
  });

  it('takes a refused message back into the composer on edit', async () => {
    await renderChat();
    fireEvent.change(screen.getByTestId('composer'), { target: { value: 'x'.repeat(200_001) } });
    fireEvent.click(screen.getByTestId('send'));
    expect(sentFrames('send')).toEqual([]);

    fireEvent.click(screen.getByTestId('edit'));
    expect((screen.getByTestId('composer') as HTMLInputElement).value).toHaveLength(200_001);
    expect(rows()).toEqual([]);
  });

  it('reloads the thread when the runtime cannot replay what the tab missed', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await renderChat();
    await waitFor(() => expect(qc.getQueryData(['thread', 'a1', 't1'])).toBeDefined());
    const loads = mockGetThread.mock.calls.length;

    mockGetThread.mockResolvedValue({ id: 't1', messages: [msg('missed', 't1')] });
    act(() => ws.serverClose(1006));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    ws = FakeWebSocket.latest();
    act(() => {
      ws.open();
      ws.deliver(welcomeFrame({ streamId: 'another-stream', resumed: false }));
    });

    await waitFor(() => expect(rows()).toEqual(['missed:t1']));
    expect(mockGetThread.mock.calls.length).toBeGreaterThan(loads);
  });

  it('opens the latest conversation again when the one bare /chat showed is gone', async () => {
    // A restart in single-thread mode hides the thread this tab resolved before it.
    mockLatestThread.mockResolvedValueOnce({ id: 't-hidden' }).mockResolvedValue({ id: 't1' });
    mockGetThread.mockImplementation(async (_agentId: string, _userId: string, threadId: string) => {
      if (threadId === 't-hidden') throw new ApiError('Thread not found', {}, 404);
      return { id: 't1', messages: [msg('kept', 't1')] };
    });

    await renderChat(<AgentChat />);

    await waitFor(() => expect(rows()).toEqual(['kept:t1']));
  });

  it('sends nothing before a thread exists', async () => {
    mockLatestThread.mockReturnValue(new Promise(() => {}));
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ChatConnectionProvider>
          <AgentChat />
        </ChatConnectionProvider>
      </QueryClientProvider>,
    );
    ws = FakeWebSocket.latest();
    act(() => {
      ws.open();
      ws.deliver(welcomeFrame());
    });
    expect(screen.getByTestId('input').dataset.status).toBe('connecting');

    fireEvent.change(screen.getByTestId('composer'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('send'));
    expect(sentFrames('send')).toEqual([]);
  });

  it('sends while a turn is in flight, with the thread on screen', async () => {
    await renderChat();
    event('turn', { threadId: 't1', state: 'running' });
    await waitFor(() => expect(screen.getByTestId('input').dataset.pending).toBe('true'));

    fireEvent.change(screen.getByTestId('composer'), { target: { value: 'change of plan' } });
    fireEvent.click(screen.getByTestId('send'));

    expect(sentFrames('send')[0]!.payload.message).toMatchObject({ threadId: 't1', content: 'change of plan' });
  });

  describe('computer state', () => {
    it('asks the runtime for the desktop state once and then waits for the socket', async () => {
      await renderChat();
      await waitFor(() => expect(mockComputerRequest).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockComputerRequest).toHaveBeenCalledTimes(1);
    });

    it('raises the waiting banner from an event for the viewed thread, and for no other', async () => {
      await renderChat();

      event('computer', { ...idleComputer, running: true, waiting: [{ id: 'use-1', threadId: 't1', mode: 'cron' }] });
      await waitFor(() =>
        expect(screen.getByTestId('computer-waiting').textContent).toContain('Waiting for the computer'),
      );

      event('computer', { ...idleComputer, running: true, waiting: [{ id: 'use-2', threadId: 't2', mode: 'chat' }] });
      await waitFor(() => expect(screen.queryByTestId('computer-waiting')).toBeNull());
    });
  });

  it('sends a dictated transcript as the user message on the thread being viewed', async () => {
    await renderChat();

    fireEvent.click(screen.getByTestId('dictation-start'));
    await waitFor(() => expect(screen.getByTestId('dictation-status').textContent).toBe('recording'));
    expect(sentFrames('dictation_start')).toHaveLength(1);

    // The microphone rides the socket as binary frames.
    const frame = new Int16Array([7, 8]).buffer;
    act(() => microphone.onFrame!(frame));
    expect(ws.sent).toContain(frame);

    fireEvent.click(screen.getByTestId('dictation-send'));
    expect(sentFrames('dictation_stop').at(-1)!.payload).toEqual({ commit: true });
    expect(screen.getByTestId('dictation-status').textContent).toBe('transcribing');

    act(() => ws.deliver({ type: 'dictation_result', payload: { text: ' Check the staging pods. ' } }));
    const sent = sentFrames('send')[0]!.payload.message;
    expect(sent).toMatchObject({ threadId: 't1', content: 'Check the staging pods.' });
    // Drawn on the thread at once, as a typed message is.
    expect(rows()).toEqual([`${sent.id}:t1:sending`]);
    expect(screen.getByTestId('dictation-status').textContent).toBe('idle');
  });

  describe('voice call', () => {
    it('places the call from the header on the thread being viewed, and plays its audio', async () => {
      await renderChat();

      fireEvent.click(screen.getByTestId('voice-call-button'));
      await waitFor(() => expect(sentFrames('voice_start').map((f) => f.payload)).toEqual([{ threadId: 't1' }]));

      act(() => ws.deliver({ type: 'voice_state', payload: { state: 'live' } }));
      expect(screen.getByTestId('voice-call-indicator')).toBeTruthy();

      const frame = new Int16Array([7, 8]).buffer;
      act(() => ws.deliverAudio(frame));
      expect(voiceAudio.enqueue).toHaveBeenCalledWith(frame);

      // The microphone belongs to the call now, so the composer says why it cannot record.
      expect(screen.getByTestId('dictation-blocked').textContent).toBe('End the call to record a voice message');

      fireEvent.click(screen.getByTestId('voice-call-end'));
      expect(sentFrames('voice_stop')).toHaveLength(1);
      expect(screen.getByTestId('dictation-blocked').textContent).toBe('');
    });

    it('holds the call back while a voice message is recording', async () => {
      await renderChat();

      fireEvent.click(screen.getByTestId('dictation-start'));
      await waitFor(() => expect(screen.getByTestId('dictation-status').textContent).toBe('recording'));

      const call = screen.getByTestId('voice-call-button');
      expect(call.hasAttribute('disabled')).toBe(true);
      expect(call.parentElement?.getAttribute('title')).toBe('Finish the voice message first');
    });
  });
});
