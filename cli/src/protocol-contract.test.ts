/**
 * Holds the terminal UI to the chat socket session the runtime recorded in
 * `src/protocol/fixtures/v2-session.json`: two clients on one conversation, a
 * duplicate resend, a reconnect that resumes, a refused send, a ping and a
 * cancel. The phone's received frames are played through the real WsClient and
 * TuiAdapter, and the frames this client sends are compared with the recorded
 * ones. The file is read, not imported: this package cannot import the runtime.
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ws', async () => {
  const { FakeWebSocket } = await import('./testing/fake-websocket.js');
  return { default: FakeWebSocket };
});

vi.mock('./config.js', () => ({
  loadConfig: () => ({ httpUrl: 'http://example.test:3003' }),
  wsUrlFromHttpUrl: (u: string) => u.replace(/^http/, 'ws') + '/api/ws',
}));

import { FakeWebSocket } from './testing/fake-websocket.js';
import { tuiAdapterService, TuiMessage, TurnEventPayload } from './tui-adapter.js';
import { ChatEntry, upsertMessage, withHistory } from './transcript.js';

const FIXTURE = fileURLToPath(new URL('../../src/protocol/fixtures/v2-session.json', import.meta.url));

interface LogEntry {
  client: string;
  direction: 'sent' | 'received' | 'closed';
  frame?: { type: string; id?: string; payload?: Record<string, unknown> };
  code?: number;
}

const recording = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  threadId: string;
  log: LogEntry[];
};

/** The recorded frame a client sent, by its request id. */
function recordedSent(id: string): NonNullable<LogEntry['frame']> {
  const entry = recording.log.find((e) => e.direction === 'sent' && e.frame?.id === id);
  if (!entry?.frame) throw new Error(`the recording has no sent frame ${id}`);
  return entry.frame;
}

/** A value's structure, with every leaf replaced by its type. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v)]));
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function stubRuntime() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { method?: string }) => ({
      ok: true,
      status: 200,
      // `POST /threads` makes the recorded thread; `GET /messages` finds it empty,
      // as it was when the phone connected.
      json: async () => (init?.method === 'POST' ? { threadId: recording.threadId } : []),
    })),
  );
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  FakeWebSocket.reset();
  stubRuntime();
  tuiAdapterService.markConnected('local');
  await tuiAdapterService.startNewSession();
});

afterEach(() => {
  tuiAdapterService.events.removeAllListeners();
  tuiAdapterService.markDisconnected();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the recorded v2 session', () => {
  it('is read from the runtime fixtures', () => {
    expect(existsSync(FIXTURE)).toBe(true);
    expect(recording.log.some((e) => e.client === 'phone')).toBe(true);
  });

  it("replays the phone's frames, across its reconnect, into the transcript in order", async () => {
    let entries: ChatEntry[] = [];
    const turns: TurnEventPayload[] = [];
    const names: Array<string | null> = [];
    tuiAdapterService.events.on('history', (h: TuiMessage[]) => (entries = withHistory(entries, h)));
    tuiAdapterService.events.on('message', (m: TuiMessage) => (entries = upsertMessage(entries, m)));
    tuiAdapterService.events.on('turn', (t: TurnEventPayload) => turns.push(t));
    tuiAdapterService.events.on('welcome', (you: { name: string | null }) => names.push(you.name));

    for (const entry of recording.log.filter((e) => e.client === 'phone')) {
      const socket = FakeWebSocket.latest();
      if (entry.direction === 'sent') {
        socket.open();
        const hello = socket.sentOf('hello').at(-1) as { payload: { protocol: number; resume?: unknown } };
        expect(shapeOf(hello)).toEqual(shapeOf(entry.frame));
        expect(hello.payload.protocol).toBe(2);
        expect(hello.payload.resume).toEqual(entry.frame?.payload?.resume);
        continue;
      }
      if (entry.direction === 'received') {
        socket.receive(entry.frame);
        await flush();
        continue;
      }
      socket.serverClose(entry.code ?? 1005);
      vi.advanceTimersByTime(1_000);
    }

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(entries.map((e) => e.message.role)).toEqual(['USER', 'AGENT', 'USER', 'AGENT']);
    expect(entries.map((e) => e.message.content)).toEqual([
      'Reply with exactly: pong',
      'pong',
      'Reply with exactly: ping',
      'ping',
    ]);
    // Another person wrote the USER messages, on the web.
    expect(entries[0]?.message.senderName).toBe('Ada Example');
    expect(names).toEqual(['Grace Example', 'Grace Example']);
    expect(turns.at(-1)).toEqual({ threadId: recording.threadId, state: 'idle', outcome: 'completed' });
  });

  it('sends send, ping and cancel frames of the recorded shapes', () => {
    const socket = FakeWebSocket.latest();
    socket.open();
    const welcome = recording.log.find((e) => e.client === 'web' && e.frame?.type === 'welcome');
    socket.receive(welcome?.frame);

    tuiAdapterService.submitUserMessage({ id: randomUUID(), text: 'Reply with exactly: pong', attachmentIds: [] });
    vi.advanceTimersByTime(25_000);
    tuiAdapterService.cancel();

    const [send] = socket.sentOf('send') as Array<{ payload: { message: { threadId: string } } }>;
    const [ping] = socket.sentOf('ping');
    const [cancel] = socket.sentOf('cancel');
    expect(shapeOf(send)).toEqual(shapeOf(recordedSent('send-1')));
    expect(send!.payload.message.threadId).toBe(recording.threadId);
    expect(shapeOf(ping)).toEqual(shapeOf(recordedSent('ping-1')));
    expect(shapeOf(cancel)).toEqual(shapeOf(recordedSent('cancel-1')));
    expect(cancel?.payload).toEqual(recordedSent('cancel-1').payload);
  });
});
