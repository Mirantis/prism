import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ws', async () => {
  const { FakeWebSocket } = await import('./testing/fake-websocket.js');
  return { default: FakeWebSocket };
});

import { FakeWebSocket } from './testing/fake-websocket.js';
import { WsClient } from './ws-client.js';

const STREAM = '07267e2b-eb98-445a-b535-76e5a987d1cb';
const THREAD = '9db4a6ef-9160-4784-bcda-c2e649edf269';

const message = {
  id: '58aa0353-ebdb-421b-ad49-75f443341eb7',
  threadId: THREAD,
  content: 'Reply with exactly: pong',
  attachmentIds: [],
};

function welcome(seq: number, resumed = false) {
  return {
    type: 'welcome',
    payload: {
      protocol: 2,
      streamId: STREAM,
      seq,
      resumed,
      you: { name: null },
      snapshot: { turns: [], computer: null },
    },
  };
}

function event(seq: number) {
  return { type: 'turn', seq, payload: { threadId: THREAD, state: 'running' } };
}

describe('WsClient', () => {
  let client: WsClient;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
    client = new WsClient({ url: 'ws://example.test/api/ws', clientVersion: 'test' });
  });

  afterEach(() => {
    client.close();
    vi.useRealTimers();
  });

  /** Open the newest socket and answer its `hello`. */
  function connect(seq = 1, resumed = false): FakeWebSocket {
    const socket = FakeWebSocket.latest();
    socket.open();
    socket.receive(welcome(seq, resumed));
    return socket;
  }

  function reconnect(afterMs = 1_000): FakeWebSocket {
    const count = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(afterMs);
    expect(FakeWebSocket.instances).toHaveLength(count + 1);
    return FakeWebSocket.latest();
  }

  it('says hello first, and sends nothing else until the welcome', () => {
    const socket = FakeWebSocket.latest();
    socket.open();
    client.send(message);

    expect(socket.sent).toEqual([
      {
        type: 'hello',
        id: expect.any(String),
        payload: { protocol: 2, client: { name: 'prism-cli', version: 'test' } },
      },
    ]);

    socket.receive(welcome(1));

    expect(socket.sentOf('send')).toEqual([
      { type: 'send', id: `send-${message.id}`, payload: { message } },
    ]);
  });

  it('sends an unconfirmed message again after a reconnect, under the same message id', () => {
    const first = connect(1);
    client.send(message);
    first.receive(event(2));
    first.serverClose(1006);

    const second = reconnect();
    second.open();
    expect(second.sentOf('hello')[0]).toMatchObject({
      payload: { resume: { streamId: STREAM, seq: 2 } },
    });
    expect(second.sentOf('send')).toEqual([]);

    second.receive(welcome(2, true));
    expect(second.sentOf('send')).toEqual([
      { type: 'send', id: `send-${message.id}`, payload: { message } },
    ]);
  });

  it('forgets a message once it is confirmed', () => {
    const first = connect(1);
    client.send(message);
    first.receive({
      type: 'ack',
      re: `send-${message.id}`,
      payload: { messageId: message.id, seq: 2, queued: false, duplicate: false },
    });
    first.serverClose(1006);

    const second = reconnect();
    second.open();
    second.receive(welcome(1, true));

    expect(second.sentOf('send')).toEqual([]);
  });

  it('reports a refused message and does not send it again', () => {
    const failures: unknown[] = [];
    client.events.on('sendFailed', (f) => failures.push(f));
    const first = connect(1);
    client.send(message);
    first.receive({
      type: 'nack',
      re: `send-${message.id}`,
      payload: { code: 'unknown_thread', message: 'There is no such conversation.' },
    });

    expect(failures).toEqual([
      { messageId: message.id, code: 'unknown_thread', message: 'There is no such conversation.' },
    ]);

    first.serverClose(1006);
    const second = reconnect();
    second.open();
    second.receive(welcome(1, true));
    expect(second.sentOf('send')).toEqual([]);
  });

  it('sends a rate-limited message again once the wait is over', () => {
    const failures: unknown[] = [];
    client.events.on('sendFailed', (f) => failures.push(f));
    const socket = connect(1);
    client.send(message);
    socket.receive({
      type: 'nack',
      re: `send-${message.id}`,
      payload: { code: 'rate_limited', message: 'Too many requests.', retryAfterMs: 500 },
    });

    vi.advanceTimersByTime(499);
    expect(socket.sentOf('send')).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(socket.sentOf('send')).toHaveLength(2);
    expect(socket.sentOf('send')[1]).toEqual(socket.sentOf('send')[0]);
    expect(failures).toEqual([]);
  });

  it('passes events on in order', () => {
    const seen: number[] = [];
    client.events.on('event', (e: { seq: number }) => seen.push(e.seq));
    const socket = connect(5);

    socket.receive(event(6));
    socket.receive(event(7));

    expect(seen).toEqual([6, 7]);
  });

  it('drops the socket at a gap and resumes from the last event it applied', () => {
    const seen: number[] = [];
    client.events.on('event', (e: { seq: number }) => seen.push(e.seq));
    const first = connect(5);

    first.receive(event(6));
    first.receive(event(8));

    expect(seen).toEqual([6]);
    expect(first.terminated).toBe(true);

    const second = reconnect();
    second.open();
    expect(second.sentOf('hello')[0]).toMatchObject({
      payload: { resume: { streamId: STREAM, seq: 6 } },
    });
    second.receive(welcome(8, true));
    second.receive(event(7));
    second.receive(event(8));
    expect(seen).toEqual([6, 7, 8]);
  });

  it('follows the runtime from its newest event when the replay is gone', () => {
    const seen: number[] = [];
    client.events.on('event', (e: { seq: number }) => seen.push(e.seq));
    const first = connect(5);
    first.serverClose(1006);

    const second = reconnect();
    second.open();
    second.receive(welcome(100, false));
    second.receive(event(101));

    expect(seen).toEqual([101]);
  });

  it('pings every 25 seconds and keeps a socket that answers', () => {
    const socket = connect(1);

    vi.advanceTimersByTime(25_000);
    const [ping] = socket.sentOf('ping');
    expect(ping).toEqual({ type: 'ping', id: expect.any(String) });
    socket.receive({ type: 'pong', re: ping!.id });

    vi.advanceTimersByTime(10_000);
    expect(socket.terminated).toBe(false);
  });

  it('treats a socket that misses the pong deadline as dead, and resumes', () => {
    const socket = connect(3);

    vi.advanceTimersByTime(25_000);
    expect(socket.sentOf('ping')).toHaveLength(1);
    vi.advanceTimersByTime(10_000);

    expect(socket.terminated).toBe(true);
    const next = reconnect();
    next.open();
    expect(next.sentOf('hello')[0]).toMatchObject({
      payload: { resume: { streamId: STREAM, seq: 3 } },
    });
  });

  it('treats a socket whose hello goes unanswered as dead', () => {
    const socket = FakeWebSocket.latest();
    socket.open();

    vi.advanceTimersByTime(10_000);

    expect(socket.terminated).toBe(true);
  });

  it('stops for good on 4426 and says the client needs an update', () => {
    const notices: string[] = [];
    client.events.on('unsupported', (reason: string) => notices.push(reason));
    const socket = FakeWebSocket.latest();
    socket.open();
    socket.receive({
      type: 'nack',
      re: null,
      payload: { code: 'protocol_unsupported', message: 'Update the app to connect.' },
    });
    socket.serverClose(4426, 'protocol unsupported');

    vi.advanceTimersByTime(120_000);

    expect(notices).toEqual(['protocol unsupported']);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('backs off 1 s, 2 s, 4 s, and resets only after 30 seconds open', () => {
    FakeWebSocket.latest().serverClose(1006);
    reconnect(1_000).serverClose(1006);
    reconnect(2_000).serverClose(1006);

    const briefly = reconnect(4_000);
    briefly.open();
    briefly.receive(welcome(1));
    vi.advanceTimersByTime(29_000);
    briefly.serverClose(1006);
    vi.advanceTimersByTime(7_999);
    const stable = reconnect(1);

    stable.open();
    stable.receive(welcome(1));
    vi.advanceTimersByTime(30_000);
    stable.serverClose(1006);
    reconnect(1_000);
  });

  it('cancels only over a live socket', () => {
    expect(client.cancel(THREAD)).toBe(false);

    const socket = connect(1);

    expect(client.cancel(THREAD)).toBe(true);
    expect(socket.sentOf('cancel')).toEqual([
      { type: 'cancel', id: expect.any(String), payload: { threadId: THREAD } },
    ]);
  });
});
