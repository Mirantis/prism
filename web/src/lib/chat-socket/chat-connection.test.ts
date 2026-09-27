// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@/types';
import { ChatConnection } from './chat-connection';
import { FakeWebSocket, STREAM_ID, welcomeFrame } from './fake-web-socket';

const THREAD = '9db4a6ef-9160-4784-bcda-c2e649edf269';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function agentMessage(id: string, seq: number, role: ConversationMessage['role'] = 'AGENT') {
  const payload: ConversationMessage = {
    id,
    threadId: THREAD,
    role,
    content: `reply ${id}`,
    triggeredBy: 'USER_INPUT',
    toolCalls: null,
    blocks: null,
    isCompacted: false,
    createdAt: new Date(Date.UTC(2026, 8, 27, 8, 0, seq)).toISOString(),
    attachments: null,
    senderName: null,
  };
  return { type: 'message', seq, payload };
}

describe('ChatConnection', () => {
  let connection: ChatConnection;

  beforeEach(() => {
    vi.useFakeTimers();
    // The backoff's jitter at its top, so every delay is the whole step.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    connection = new ChatConnection(() => 'ws://test/api/ws');
  });

  afterEach(() => {
    connection.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Start, open and welcome. The resync that a fresh welcome starts is let through. */
  async function connect(welcome = welcomeFrame()) {
    connection.start();
    const ws = FakeWebSocket.latest();
    ws.open();
    ws.deliver(welcome);
    await vi.advanceTimersByTimeAsync(0);
    return ws;
  }

  it('says hello first and sends nothing else before welcome', () => {
    connection.start();
    const ws = FakeWebSocket.latest();
    expect(ws.binaryType).toBe('arraybuffer');
    ws.open();

    connection.send(THREAD, 'early', []);
    expect(connection.voiceStart({ threadId: THREAD })).toBe(false);
    expect(connection.cancel(THREAD)).toBe(false);

    expect(ws.frames).toEqual([
      { type: 'hello', id: expect.any(String), payload: { protocol: 2, client: { name: 'web' } } },
    ]);
    expect(connection.getState().status).toBe('connecting');

    // The message waited in the outbox, and goes out once the runtime has said welcome.
    ws.deliver(welcomeFrame());
    expect(connection.getState().status).toBe('connected');
    expect(ws.frames.at(-1)).toMatchObject({ type: 'send', payload: { message: { content: 'early' } } });
  });

  it('draws a message at once and keeps it until its stored copy arrives', async () => {
    const ws = await connect();

    const id = connection.send(THREAD, 'hello', []);
    expect(id).toMatch(UUID_V4);
    expect(connection.getState().pending).toEqual([
      expect.objectContaining({ id, threadId: THREAD, role: 'USER', content: 'hello', delivery: 'sending', senderName: 'Ada Example' }),
    ]);

    const frame = ws.frames.at(-1)!;
    expect(frame).toEqual({
      type: 'send',
      id: expect.any(String),
      payload: { message: { id, threadId: THREAD, content: 'hello', attachmentIds: [] } },
    });

    ws.deliver(agentMessage(id, 1, 'USER'));
    expect(connection.getState().pending).toEqual([]);
    // The answer comes after the copy, as the recorded runtime sends it.
    ws.deliver({ type: 'ack', re: frame.id, payload: { messageId: id, seq: 1, queued: false, duplicate: false } });
    expect(connection.getState().pending).toEqual([]);
  });

  it('stops resending a stored message and drops it once history reloads', async () => {
    let finishReload!: () => void;
    connection.listen({ resync: () => new Promise<void>((resolve) => (finishReload = resolve)) });
    connection.start();
    const ws = FakeWebSocket.latest();
    ws.open();
    ws.deliver(welcomeFrame());
    finishReload();
    await vi.advanceTimersByTimeAsync(0);

    connection.send(THREAD, 'hello', []);
    ws.deliver({ type: 'ack', re: ws.frames.at(-1)!.id, payload: { seq: 1, queued: false, duplicate: false } });
    expect(connection.getState().pending).toHaveLength(1);

    // The replay is gone, and its copy with it. The reload has it instead.
    ws.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    const next = FakeWebSocket.latest();
    next.open();
    next.deliver(welcomeFrame({ streamId: 'another-stream' }));
    expect(next.frames.map((f) => f.type)).toEqual(['hello']);
    expect(connection.getState().pending).toHaveLength(1);

    finishReload();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().pending).toEqual([]);
  });

  it('sends an unconfirmed message again after a reconnect, under the same id', async () => {
    const ws = await connect(welcomeFrame({ seq: 4 }));
    const id = connection.send(THREAD, 'hello', []);
    const firstRequest = ws.frames.at(-1)!.id;

    ws.serverClose(1006);
    expect(connection.getState().status).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(1_000);

    const next = FakeWebSocket.latest();
    expect(next).not.toBe(ws);
    next.open();
    expect(next.frames).toEqual([
      {
        type: 'hello',
        id: expect.any(String),
        payload: { protocol: 2, client: { name: 'web' }, resume: { streamId: STREAM_ID, seq: 4 } },
      },
    ]);

    next.deliver(welcomeFrame({ seq: 4, resumed: true }));
    const resend = next.frames.at(-1)!;
    expect(resend.type).toBe('send');
    expect(resend.payload.message.id).toBe(id);
    expect(resend.id).not.toBe(firstRequest);

    // The runtime already had it, and says so. Its copy is in the replay.
    next.deliver({ type: 'ack', re: resend.id, payload: { messageId: id, seq: 5, queued: false, duplicate: true } });
    next.deliver(agentMessage(id, 5, 'USER'));
    expect(connection.getState().pending).toEqual([]);
  });

  it('marks a refused message failed and never sends it again', async () => {
    const ws = await connect();
    const id = connection.send(THREAD, 'hello', []);
    ws.deliver({ type: 'nack', re: ws.frames.at(-1)!.id, payload: { code: 'unknown_thread', message: 'no such thread' } });

    expect(connection.getState().pending).toEqual([
      expect.objectContaining({ id, delivery: 'failed', deliveryError: 'This conversation no longer exists.' }),
    ]);

    ws.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    const next = FakeWebSocket.latest();
    next.open();
    next.deliver(welcomeFrame({ resumed: true }));
    expect(next.frames.map((f) => f.type)).toEqual(['hello']);
  });

  it('retries a failed message as a new message, and discards one on request', async () => {
    const ws = await connect();
    const id = connection.send(THREAD, 'hello', []);
    ws.deliver({ type: 'nack', re: ws.frames.at(-1)!.id, payload: { code: 'failed', message: 'db down' } });

    connection.retry(id);
    const [retried] = connection.getState().pending;
    expect(retried).toMatchObject({ content: 'hello', delivery: 'sending' });
    expect(retried!.id).not.toBe(id);
    expect(ws.frames.at(-1)!.payload.message.id).toBe(retried!.id);

    ws.deliver({ type: 'nack', re: ws.frames.at(-1)!.id, payload: { code: 'failed', message: 'db down' } });
    connection.discard(retried!.id);
    expect(connection.getState().pending).toEqual([]);
  });

  it('waits out a rate limit and then sends the same message again', async () => {
    const ws = await connect();
    const id = connection.send(THREAD, 'hello', []);
    ws.deliver({
      type: 'nack',
      re: ws.frames.at(-1)!.id,
      payload: { code: 'rate_limited', message: 'slow down', retryAfterMs: 2_000 },
    });
    expect(connection.getState().pending[0]!.delivery).toBe('sending');
    const sends = () => ws.frames.filter((f) => f.type === 'send');

    await vi.advanceTimersByTimeAsync(1_999);
    expect(sends()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sends()).toHaveLength(2);
    expect(sends()[1]!.payload.message.id).toBe(id);
  });

  it('refuses a message longer than the runtime stores without sending it', async () => {
    const ws = await connect();
    connection.send(THREAD, 'x'.repeat(200_001), []);

    expect(connection.getState().pending[0]).toMatchObject({
      delivery: 'failed',
      deliveryError: 'A message can be up to 200,000 characters.',
    });
    expect(ws.frames.map((f) => f.type)).toEqual(['hello']);
  });

  it('applies events in order and resumes from the last one after a gap', async () => {
    const seen: string[] = [];
    connection.listen({ message: (m) => seen.push(m.id) });
    const ws = await connect(welcomeFrame({ seq: 10 }));

    ws.deliver(agentMessage('m11', 11));
    ws.deliver(agentMessage('m13', 13));

    expect(seen).toEqual(['m11']);
    expect(ws.closedWith).toBe(1000);
    // Through the backoff, so a runtime that misnumbers on every connection cannot
    // spin the tab in a loop.
    expect(FakeWebSocket.latest()).toBe(ws);
    await vi.advanceTimersByTimeAsync(1_000);
    const next = FakeWebSocket.latest();
    expect(next).not.toBe(ws);
    next.open();
    expect(next.frames[0]!.payload.resume).toEqual({ streamId: STREAM_ID, seq: 11 });

    next.deliver(welcomeFrame({ seq: 13, resumed: true }));
    next.deliver(agentMessage('m12', 12));
    next.deliver(agentMessage('m13', 13));
    expect(seen).toEqual(['m11', 'm12', 'm13']);
  });

  it('pings every 25 seconds and reconnects when no pong comes within 10', async () => {
    const ws = await connect();

    await vi.advanceTimersByTimeAsync(25_000);
    const ping = ws.frames.at(-1)!;
    expect(ping).toEqual({ type: 'ping', id: expect.any(String) });
    ws.deliver({ type: 'pong', re: ping.id });

    await vi.advanceTimersByTimeAsync(25_000);
    const unanswered = ws.frames.at(-1)!;
    expect(unanswered.type).toBe('ping');
    expect(unanswered.id).not.toBe(ping.id);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.closedWith).toBe(1000);
    expect(connection.getState().status).toBe('disconnected');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('backs off between failed attempts and starts over after 30 seconds connected', async () => {
    connection.start();
    FakeWebSocket.latest().serverClose(1006);

    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.latest().serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // Open for 30 seconds: the next drop waits the first step again.
    const stable = FakeWebSocket.latest();
    stable.open();
    stable.deliver(welcomeFrame());
    await vi.advanceTimersByTimeAsync(30_000);
    stable.deliver({ type: 'pong', re: stable.frames.at(-1)!.id });
    stable.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('stops for good and asks for an update when the runtime speaks another protocol', async () => {
    const ws = await connect();
    ws.deliver({
      type: 'nack',
      re: null,
      payload: { code: 'protocol_unsupported', message: 'Update the app to connect.' },
    });
    ws.serverClose(4426);

    expect(connection.getState().status).toBe('update-required');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('waits for a replaced tab to be looked at before it reconnects', async () => {
    const ws = await connect();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    ws.serverClose(4001);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('keeps the turn state from the snapshot and the turn events', async () => {
    const turns: unknown[] = [];
    connection.listen({ turn: (e) => turns.push(e) });
    const ws = await connect(welcomeFrame({ snapshot: { turns: [{ threadId: 't-other', state: 'queued' }], computer: null } }));
    expect(connection.getState().turns).toEqual({ 't-other': 'queued' });

    ws.deliver({ type: 'turn', seq: 1, payload: { threadId: THREAD, state: 'running' } });
    expect(connection.getState().turns).toEqual({ 't-other': 'queued', [THREAD]: 'running' });

    // A message is not the end of a turn; only `idle` is.
    ws.deliver(agentMessage('m2', 2));
    expect(connection.getState().turns[THREAD]).toBe('running');

    ws.deliver({ type: 'turn', seq: 3, payload: { threadId: THREAD, state: 'idle', outcome: 'failed', error: 'The model is unavailable.' } });
    expect(connection.getState().turns).toEqual({ 't-other': 'queued' });
    expect(turns.at(-1)).toEqual({ threadId: THREAD, state: 'idle', outcome: 'failed', error: 'The model is unavailable.' });
  });

  it('holds the events that arrive while history reloads and applies them after', async () => {
    let finishReload!: () => void;
    const seen: string[] = [];
    connection.listen({
      message: (m) => seen.push(m.id),
      resync: () => new Promise<void>((resolve) => (finishReload = resolve)),
    });
    connection.start();
    const ws = FakeWebSocket.latest();
    ws.open();
    ws.deliver(welcomeFrame({ seq: 7 }));

    ws.deliver(agentMessage('m8', 8));
    ws.deliver(agentMessage('m9', 9));
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual([]);

    finishReload();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(['m8', 'm9']);
  });

  it('holds events around any other reload too, and releases them in order', async () => {
    const seen: string[] = [];
    connection.listen({ message: (m) => seen.push(m.id) });
    const ws = await connect();

    let finish!: (value: string) => void;
    const reload = connection.holdEvents(new Promise<string>((resolve) => (finish = resolve)));
    ws.deliver(agentMessage('m1', 1));
    expect(seen).toEqual([]);

    finish('history');
    await expect(reload).resolves.toBe('history');
    // Still held until the reload's result is in place.
    ws.deliver(agentMessage('m2', 2));
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(['m1', 'm2']);
  });

  it('drops events held from a socket that died when the next welcome cannot resume', async () => {
    const seen: string[] = [];
    connection.listen({ message: (m) => seen.push(m.id) });
    const ws = await connect();

    let finish!: (value: string) => void;
    void connection.holdEvents(new Promise<string>((resolve) => (finish = resolve)));
    ws.deliver(agentMessage('stale', 1));
    ws.close(1006);
    await vi.advanceTimersByTimeAsync(1_000);

    const next = FakeWebSocket.latest();
    next.open();
    next.deliver(welcomeFrame({ seq: 40, resumed: false }));
    finish('history');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
  });

  it('shows a turn at once, even while a reload holds messages', async () => {
    const ws = await connect();
    void connection.holdEvents(new Promise<never>(() => {}));
    ws.deliver({ type: 'turn', seq: 1, payload: { threadId: THREAD, state: 'running' } });
    expect(connection.getState().turns[THREAD]).toBe('running');
  });

  it('sends cancel, voice and dictation requests in the envelope', async () => {
    const ws = await connect();
    const audio = new Int16Array([1, 2]).buffer;

    expect(connection.cancel(THREAD)).toBe(true);
    expect(connection.voiceStart({ threadId: THREAD })).toBe(true);
    connection.sendAudio(audio);
    connection.voiceStop();
    expect(connection.dictationStart()).toBe(true);
    connection.dictationStop(true);

    expect(ws.frames.slice(1)).toEqual([
      { type: 'cancel', id: expect.any(String), payload: { threadId: THREAD } },
      { type: 'voice_start', id: expect.any(String), payload: { threadId: THREAD } },
      { type: 'voice_stop', id: expect.any(String), payload: {} },
      { type: 'dictation_start', id: expect.any(String), payload: {} },
      { type: 'dictation_stop', id: expect.any(String), payload: { commit: true } },
    ]);
    expect(ws.sent).toContain(audio);
  });

  it('hands audio and the clear that cancels it over in arrival order', async () => {
    const seen: string[] = [];
    connection.listen({ voiceAudio: () => seen.push('audio'), voice: (e) => seen.push(e.type) });
    const ws = await connect();

    ws.deliverAudio(new Uint8Array([1]).buffer);
    ws.deliver({ type: 'voice_clear' });
    ws.deliverAudio(new Uint8Array([2]).buffer);

    expect(seen).toEqual(['audio', 'clear', 'audio']);
  });

  it('normalizes voice and dictation frames the way the runtime sends them', async () => {
    const voice = vi.fn();
    const dictation = vi.fn();
    connection.listen({ voice, dictation });
    const ws = await connect();

    ws.deliver({ type: 'voice_hello', payload: { format: { encoding: 'pcm16', sampleRate: 24_000, channels: 1 } } });
    ws.deliver({ type: 'voice_state', payload: { state: 'live', desktop: true } });
    ws.deliver({ type: 'voice_error', payload: {} });
    ws.deliver({ type: 'dictation_delta', payload: { text: 'Mock dictation ' } });
    ws.deliver({ type: 'dictation_result', payload: { text: 'Mock dictation of 1000 ms.' } });
    ws.deliver({ type: 'dictation_error', payload: {} });

    expect(voice.mock.calls.map(([e]) => e)).toEqual([
      { type: 'hello', format: { encoding: 'pcm16', sampleRate: 24_000, channels: 1 } },
      { type: 'state', state: 'live', desktop: true },
      { type: 'error', error: 'The voice chat could not run.' },
    ]);
    expect(dictation.mock.calls.map(([e]) => e)).toEqual([
      { type: 'delta', text: 'Mock dictation ' },
      { type: 'result', text: 'Mock dictation of 1000 ms.' },
      { type: 'error', error: 'The dictation could not be transcribed.' },
    ]);
  });
});
