/**
 * The screen endpoint's handling of a second watcher.
 *
 * There is one screen and one session, so attaching starts a stream that replaces the one
 * before it. A reload is two sockets whose lifetimes overlap, which makes the order of
 * release and attach the thing worth pinning: get it the wrong way round and the new
 * client's stream is the one that gets stopped.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Every stream a client attach started, newest last. */
const streams: Array<{ id: number; running: boolean }> = [];

/**
 * The computer's one screen, modelled as `AgentComputer` holds it: starting a stream puts
 * it in the slot, replacing whatever was there, and stopping one stops whatever is in the
 * slot now rather than the stream the caller started. That is what makes the order of
 * release and attach matter at all.
 */
let slot: { id: number; running: boolean } | null = null;

const attachComputerClient = vi.fn(() => {
  const stream = { id: streams.length + 1, running: true };
  streams.push(stream);
  slot = stream;
  return () => {
    if (slot) slot.running = false;
    slot = null;
  };
});

vi.mock('../../voice/voice-chat.service', () => ({
  voiceChatService: {
    attachComputerClient: (...args: unknown[]) => attachComputerClient(...(args as [])),
    handleComputerInput: vi.fn(),
  },
}));

const { computerEndpoint } = await import('../computer-endpoint');

/** A client socket, open, recording what it was sent and whether it was closed. */
function fakeSocket() {
  const ws = new EventEmitter() as EventEmitter & {
    readyState: number;
    bufferedAmount: number;
    sent: unknown[];
    closed: boolean;
    send: (data: unknown) => void;
    close: () => void;
    ping: () => void;
  };
  ws.readyState = 1;
  ws.bufferedAmount = 0;
  ws.sent = [];
  ws.closed = false;
  ws.send = (data) => ws.sent.push(data);
  ws.close = () => {
    ws.closed = true;
    ws.readyState = 3;
  };
  ws.ping = () => {};
  return ws;
}

/** `serve` is the endpoint's own; a test reaches it the way the upgrade handler does. */
const serve = (ws: unknown) =>
  (computerEndpoint as unknown as { serve: (ws: unknown) => void }).serve(ws);

beforeEach(() => {
  streams.length = 0;
  slot = null;
  attachComputerClient.mockClear();
  // Nothing is watching at the start of each test.
  (computerEndpoint as unknown as { watcher: unknown }).watcher = null;
});

describe('a second watcher taking over', () => {
  it('leaves the newcomer with the running stream', () => {
    const first = fakeSocket();
    serve(first);
    expect(streams).toEqual([{ id: 1, running: true }]);

    const second = fakeSocket();
    serve(second);

    // The first stream stopped and the second is the one running. Reversed, the detach
    // of the first would stop the second, and the first would encode for nobody.
    expect(streams).toEqual([
      { id: 1, running: false },
      { id: 2, running: true },
    ]);
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
  });

  it('stops the stream when the watching socket goes away', () => {
    const ws = fakeSocket();
    serve(ws);
    expect(streams[0].running).toBe(true);

    ws.emit('close');

    expect(streams[0].running).toBe(false);
  });

  it('says so and closes when the session has no computer to show', () => {
    attachComputerClient.mockReturnValueOnce(null as never);
    const ws = fakeSocket();

    serve(ws);

    expect(ws.sent).toEqual([
      JSON.stringify({ type: 'error', message: 'there is no voice chat with a computer running' }),
    ]);
    expect(ws.closed).toBe(true);
  });
});
