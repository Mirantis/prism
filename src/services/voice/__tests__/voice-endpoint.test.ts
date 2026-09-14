/**
 * The socket a voice chat with a computer runs on, with the session owner as a double.
 *
 * What is worth pinning here is the claim: which socket holds the endpoint, when it lets
 * go, and what happens to a page that arrives while another one is still opening. A
 * session takes seconds to start, so those windows are wide, and a socket that goes on
 * feeding audio after losing the claim feeds it into somebody else's call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Server as HttpServer } from 'http';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../config', () => ({
  config: { agentId: 'agent-1', ownerUserId: 'user-1' },
}));

vi.mock('../../meeting/openai-endpoint', () => ({ isRealtimeConfigured: () => true }));
vi.mock('../../../lib/origin-guard', () => ({ isAllowedOrigin: () => true }));

/** The session owner, reduced to what the endpoint asks of it. */
const service = {
  start: vi.fn(async (_input: unknown) => true),
  stop: vi.fn(async () => {}),
  pushAudio: vi.fn(),
  handleComputerInput: vi.fn(),
};
vi.mock('../voice-chat.service', () => ({ voiceChatService: service }));

/** The `ws` server, which hands the endpoint whatever socket a test opens. */
const upgraded: ((ws: FakeSocket) => void)[] = [];
class FakeWebSocketServer {
  static instances: FakeWebSocketServer[] = [];
  readonly close = vi.fn();
  constructor() {
    FakeWebSocketServer.instances.push(this);
  }
  handleUpgrade(_req: unknown, _socket: unknown, _head: unknown, done: (ws: FakeSocket) => void) {
    upgraded.push(done);
  }
}

/** Just enough of a client socket to be claimed, written to and closed. */
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  readonly sent: unknown[] = [];
  /** How much the socket has not written yet, which the screen is skipped over. */
  bufferedAmount = 0;
  readonly close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = 3;
  });
  send(data: unknown) {
    this.sent.push(data);
  }
  /** The screen pictures this socket was sent: their tag byte and whether each stands alone. */
  get pictures(): Array<{ keyframe: boolean }> {
    return this.sent
      .filter((d): d is Buffer => Buffer.isBuffer(d) && d[0] === 0x03)
      .map((d) => ({ keyframe: d[1] === 1 }));
  }
  /** The status frames this socket was told about, in order. */
  get states(): string[] {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as { type: string; state?: string })
      .filter((f) => f.type === 'status')
      .map((f) => f.state ?? '');
  }
}

vi.mock('ws', () => ({
  default: { OPEN: 1 },
  WebSocketServer: FakeWebSocketServer,
}));

const { voiceEndpoint } = await import('../voice-endpoint');
const { resetUpgrades } = await import('../../websocket-upgrades');

/** Open the endpoint on a fresh server and hand back a way to connect sockets to it. */
function open() {
  const server = new EventEmitter() as unknown as HttpServer;
  voiceEndpoint.initialize(server);
  return (ws: FakeSocket): void => {
    (server as unknown as EventEmitter).emit(
      'upgrade',
      { url: '/api/voice', headers: {} },
      { destroy: vi.fn(), write: vi.fn() },
      Buffer.alloc(0),
    );
    upgraded.pop()?.(ws);
  };
}

beforeEach(() => {
  resetUpgrades();
  upgraded.length = 0;
  FakeWebSocketServer.instances.length = 0;
  service.start.mockClear().mockImplementation(async () => true);
  service.stop.mockClear();
  service.pushAudio.mockClear();
  service.handleComputerInput.mockClear();
});

afterEach(() => {
  voiceEndpoint.close();
});

describe('a connection', () => {
  it('opens a session with a computer at the rate the client speaks', async () => {
    const connect = open();
    const ws = new FakeSocket();
    connect(ws);
    await vi.waitFor(() => expect(service.start).toHaveBeenCalled());

    expect(service.start).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'computer', computer: true, sampleRate: 48_000 }),
    );
    expect(ws.states).toEqual(['connecting']);
  });

  it('routes audio and page frames only while it holds the claim', async () => {
    const connect = open();
    const ws = new FakeSocket();
    connect(ws);
    await vi.waitFor(() => expect(service.start).toHaveBeenCalled());

    ws.emit('message', Buffer.from([1, 2]), true);
    ws.emit('message', Buffer.from('{"type":"wheel","dy":1}'), false);
    expect(service.pushAudio).toHaveBeenCalledTimes(1);
    expect(service.handleComputerInput).toHaveBeenCalledTimes(1);

    // Displaced by another page. Its frames would land in that page's session.
    const second = new FakeSocket();
    connect(second);
    await vi.waitFor(() => expect(service.start).toHaveBeenCalledTimes(2));

    ws.emit('message', Buffer.from([1, 2]), true);
    expect(service.pushAudio).toHaveBeenCalledTimes(1);
  });

  it('ends the session and closes the socket when the client goes away', async () => {
    const connect = open();
    const ws = new FakeSocket();
    connect(ws);
    await vi.waitFor(() => expect(service.start).toHaveBeenCalled());

    ws.emit('close');

    expect(service.stop).toHaveBeenCalledWith('the client disconnected', 'disconnected');
  });

  it('survives a malformed frame rather than taking the process with it', () => {
    const connect = open();
    const ws = new FakeSocket();
    connect(ws);

    // `ws` emits this for an invalid opcode or bad UTF-8, and an `error` with no listener
    // is an uncaught exception. The listener has to be on before the first await.
    expect(() => ws.emit('error', new Error('invalid opcode'))).not.toThrow();
  });
});

describe('a second page', () => {
  it('takes the call over, and the first is told and closed', async () => {
    const connect = open();
    const first = new FakeSocket();
    connect(first);
    await vi.waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));

    const second = new FakeSocket();
    connect(second);
    await vi.waitFor(() => expect(service.start).toHaveBeenCalledTimes(2));

    expect(service.stop).toHaveBeenCalledWith(
      'another page took over the voice chat',
      'disconnected',
    );
    // Closed rather than left holding a microphone for a call it no longer has.
    expect(first.close).toHaveBeenCalled();
  });

  it('takes over a session that is still opening, and the first start gives up', async () => {
    const connect = open();
    let release: (() => void) | undefined;
    service.start.mockImplementationOnce(
      async () => new Promise<boolean>((resolve) => {
        release = () => resolve(false);
      }),
    );

    const first = new FakeSocket();
    connect(first);
    await vi.waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));

    const second = new FakeSocket();
    connect(second);
    await vi.waitFor(() => expect(service.start).toHaveBeenCalledTimes(2));

    // The cancelled start returns false. It must not take the claim the second page now
    // holds, or the runtime would end up with a session and no socket on it.
    release?.();
    await vi.waitFor(() => expect(second.close).not.toHaveBeenCalled());
    second.emit('close');
    expect(service.stop).toHaveBeenLastCalledWith('the client disconnected', 'disconnected');
  });
});

describe('a refused session', () => {
  it('closes the socket and gives the claim back, so the next page is not displaced', async () => {
    const connect = open();
    service.start.mockImplementationOnce(async () => false);

    const refused = new FakeSocket();
    connect(refused);
    await vi.waitFor(() => expect(refused.close).toHaveBeenCalled());

    const next = new FakeSocket();
    connect(next);
    await vi.waitFor(() => expect(service.start).toHaveBeenCalledTimes(2));

    // Nothing was running, so nothing was taken over.
    expect(service.stop).not.toHaveBeenCalled();
  });
});

/**
 * A picture of the screen is read against the one before it, so one sent after a skip
 * decodes into rubbish. What is pinned here is that a client which fell behind is given
 * nothing until a picture that stands on its own, rather than a run it cannot read.
 */
describe('the screen on a socket that is behind', () => {
  /** The signal the endpoint handed the session owner, which is where pictures go in. */
  async function screenSink(ws: FakeSocket) {
    const connect = open();
    connect(ws);
    await vi.waitFor(() => expect(service.start).toHaveBeenCalled());
    const input = service.start.mock.calls[0][0] as {
      signal: { screen?: (frame: unknown) => void };
    };
    const screen = input.signal.screen;
    if (!screen) throw new Error('the endpoint offered no screen');
    screen({ kind: 'start', encoding: 'h264', codec: 'avc1.64001F' });
    return screen;
  }

  it('sends every picture while the socket keeps up', async () => {
    const ws = new FakeSocket();
    const screen = await screenSink(ws);

    screen({ kind: 'h264', data: Buffer.from([1]), keyframe: true });
    screen({ kind: 'h264', data: Buffer.from([2]), keyframe: false });
    screen({ kind: 'h264', data: Buffer.from([3]), keyframe: false });

    expect(ws.pictures).toEqual([{ keyframe: true }, { keyframe: false }, { keyframe: false }]);
  });

  it('skips a whole run, and comes back on a picture that stands on its own', async () => {
    const ws = new FakeSocket();
    const screen = await screenSink(ws);

    screen({ kind: 'h264', data: Buffer.from([1]), keyframe: true });
    ws.bufferedAmount = 10 * 1024 * 1024;
    screen({ kind: 'h264', data: Buffer.from([2]), keyframe: false });
    // Drained again, but the pictures since the skip cannot be read on their own.
    ws.bufferedAmount = 0;
    screen({ kind: 'h264', data: Buffer.from([3]), keyframe: false });
    screen({ kind: 'h264', data: Buffer.from([4]), keyframe: true });
    screen({ kind: 'h264', data: Buffer.from([5]), keyframe: false });

    expect(ws.pictures).toEqual([{ keyframe: true }, { keyframe: true }, { keyframe: false }]);
  });

  it('sends a picture that stands on its own even while the socket is behind', async () => {
    const ws = new FakeSocket();
    const screen = await screenSink(ws);

    ws.bufferedAmount = 10 * 1024 * 1024;
    screen({ kind: 'h264', data: Buffer.from([1]), keyframe: true });

    // Holding this one back would leave the screen frozen for as long as the client is
    // slow, since nothing after it can be read without it.
    expect(ws.pictures).toEqual([{ keyframe: true }]);
  });
});
