import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@/types';
import { ChatConnection } from './chat-connection';
import { FakeWebSocket } from './fake-web-socket';
import { upsertMessage } from './transcript';

/**
 * A session recorded from the v2 runtime: two clients, "web" and "phone", on one
 * thread, with a phone reconnect that resumes. Read from disk rather than imported,
 * since the web build cannot depend on runtime code.
 */
interface Recording {
  threadId: string;
  log: Array<
    | { client: string; direction: 'sent' | 'received'; frame: Record<string, any> }
    | { client: string; direction: 'closed'; code: number }
  >;
}

const recording = JSON.parse(
  readFileSync(new URL('../../../../backend/src/protocol/fixtures/v2-session.json', import.meta.url), 'utf8'),
) as Recording;

function framesOf(client: string, direction: 'sent' | 'received') {
  return recording.log.flatMap((entry) =>
    entry.client === client && entry.direction === direction && 'frame' in entry ? [entry.frame] : [],
  );
}

/** A frame with every value replaced by its type, so two frames compare by shape. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]));
  }
  return typeof value;
}

/** The recorded hello, without the optional client version this client leaves out. */
function recordedHello(index: number) {
  const hello = framesOf('phone', 'sent').filter((f) => f.type === 'hello')[index]!;
  const { version: _version, ...client } = hello.payload.client;
  return { ...hello, payload: { ...hello.payload, client } };
}

describe('the recorded v2 session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("replays the phone's side, reconnect included, into the right transcript", async () => {
    const connection = new ChatConnection(() => 'ws://test/api/ws');
    let transcript: ConversationMessage[] = [];
    const titles: Array<string | null> = [];
    connection.listen({
      message: (m) => (transcript = upsertMessage(transcript, m)),
      thread: (e) => titles.push(e.title),
    });
    connection.start();

    // Every frame the phone received, split at the drop into the two sockets it had.
    const phoneLog = recording.log.filter((e) => e.client === 'phone');
    const drop = phoneLog.findIndex((e) => e.direction === 'closed');
    const received = (entries: typeof phoneLog) =>
      entries.flatMap((e) => (e.direction === 'received' ? [e.frame] : []));

    const first = FakeWebSocket.latest();
    first.open();
    expect(shape(first.frames[0])).toEqual(shape(recordedHello(0)));
    for (const frame of received(phoneLog.slice(0, drop))) first.deliver(frame);
    await vi.advanceTimersByTimeAsync(0);
    first.serverClose((phoneLog[drop] as { code: number }).code);

    await vi.advanceTimersByTimeAsync(1_000);
    const second = FakeWebSocket.latest();
    expect(second).not.toBe(first);
    second.open();
    // The cursor is the last event the phone applied, exactly as the phone recorded it.
    expect(second.frames[0]!.payload.resume).toEqual(recordedHello(1).payload.resume);
    expect(shape(second.frames[0])).toEqual(shape(recordedHello(1)));
    for (const frame of received(phoneLog.slice(drop + 1))) second.deliver(frame);
    await vi.advanceTimersByTimeAsync(0);

    expect(transcript.map((m) => [m.role, m.content, m.senderId])).toEqual([
      ['USER', 'Reply with exactly: pong', 'ada@example.com'],
      ['AGENT', 'pong', null],
      ['USER', 'Reply with exactly: ping', 'ada@example.com'],
      ['AGENT', 'ping', null],
    ]);
    expect(titles).toEqual(['Reply with exactly:', 'pong']);
    const state = connection.getState();
    expect(state.turns).toEqual({});
    // Ada wrote both messages from the web, so the phone shows them as hers.
    expect(state.you).toEqual({ id: 'grace@example.com', name: 'grace@example.com' });
    // The replay was applied in order, with no gap and so no third socket.
    expect(FakeWebSocket.instances).toHaveLength(2);

    connection.stop();
  });

  it('sends send, ping and cancel frames the recorded runtime accepted', async () => {
    const recorded = framesOf('web', 'sent');
    const byId = (id: string) => recorded.find((f) => f.id === id)!;
    const connection = new ChatConnection(() => 'ws://test/api/ws');
    connection.start();
    const ws = FakeWebSocket.latest();
    ws.open();
    ws.deliver(framesOf('web', 'received').find((f) => f.type === 'welcome')!);

    const messageId = connection.send(recording.threadId, 'Reply with exactly: pong', []);
    const send = ws.frames.at(-1)!;
    expect(shape(send)).toEqual(shape(byId('send-1')));
    expect(send.payload.message).toEqual({ ...byId('send-1').payload.message, id: messageId });
    // The runtime's rule for a message id: a version-4 uuid.
    expect(messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(shape(ws.frames.at(-1))).toEqual(shape(byId('ping-1')));

    connection.cancel(recording.threadId);
    const cancel = ws.frames.at(-1)!;
    expect(shape(cancel)).toEqual(shape(byId('cancel-1')));
    expect(cancel.payload).toEqual(byId('cancel-1').payload);

    connection.stop();
  });
});
