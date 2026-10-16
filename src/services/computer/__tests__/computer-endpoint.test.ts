import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const clients = new Map<string, unknown>();
const access = new EventEmitter();
const detach = vi.fn((id: string) => clients.delete(id));
const attach = vi.fn(async (id: string, viewer: unknown) => {
  clients.set(id, viewer);
  return () => detach(id);
});
const session = { id: 'local', attach, detach, input: vi.fn(), status: () => ({ running: true }) };
vi.mock('../computer.service', () => ({
  LOCAL_COMPUTER_ID: 'local',
  computerService: {
    on: (event: string, listener: () => void) => access.on(event, listener),
    off: (event: string, listener: () => void) => access.off(event, listener),
    session: () => session,
    summaries: () => [],
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
  (computerEndpoint as unknown as { serve: (ws: unknown, session: unknown) => void }).serve(ws, session);

beforeEach(() => {
  clients.clear(); access.removeAllListeners(); attach.mockClear(); detach.mockClear();
});

describe('computer viewers', () => {
  it('keeps both viewers connected', async () => {
    const first = fakeSocket(), second = fakeSocket();
    serve(first); serve(second);
    await Promise.resolve();
    expect(clients.size).toBe(2);
    expect(first.closed).toBe(false);
    expect(second.closed).toBe(false);
    expect(JSON.parse(first.sent[0] as string).clientId).not.toBe(JSON.parse(second.sent[0] as string).clientId);
  });

  it('detaches only the socket that closed', async () => {
    const first = fakeSocket(), second = fakeSocket();
    serve(first); serve(second); await Promise.resolve();
    first.readyState = 3; first.emit('close');
    expect(clients.size).toBe(1);
    expect(second.closed).toBe(false);
    expect(access.listenerCount('change')).toBe(1);
  });

  it('reports desktop startup failure to the viewer', async () => {
    attach.mockRejectedValueOnce(new Error('Desktop failed to start.'));
    const ws = fakeSocket(); serve(ws);
    await vi.waitFor(() => expect(ws.closed).toBe(true));
    expect(ws.sent).toContain(JSON.stringify({ type: 'error', message: 'Desktop failed to start.' }));
  });
});
