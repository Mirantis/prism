/**
 * Chat protocol v2, against real sockets.
 *
 * A real handshake against the real gateway and its real stream. What happens to
 * a message once accepted is `inboundMessageService`'s, stubbed here so each test
 * says what the service answered; its own behaviour has tests of its own.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';

const { mockInbox, MockInboundMessageError, mockTrackEvent } = vi.hoisted(() => {
  class MockInboundMessageError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    MockInboundMessageError,
    mockTrackEvent: vi.fn(),
    mockInbox: {
      accept: vi.fn(),
      cancel: vi.fn(),
      turns: vi.fn(() => [] as Array<{ threadId: string; state: string }>),
    },
  };
});

vi.mock('./inbound-message.service', () => ({
  inboundMessageService: mockInbox,
  InboundMessageError: MockInboundMessageError,
}));

vi.mock('../lib/telemetry', () => ({ trackEvent: mockTrackEvent }));

import { webSocketGatewayService, MAX_CONNECTIONS } from './websocket-gateway.service';
import { eventStreamService } from './event-stream.service';
import { CLOSE_CODES, PROTOCOL_VERSION } from '../protocol/chat-protocol';

const THREAD = '3f0c2a52-9a1e-4b8e-9d1c-2f7f3c1a0b11';
const MESSAGE = '8d7e6f5a-4b3c-4d2e-9f1a-0b1c2d3e4f5a';

/** A client that keeps every frame it was sent, and can wait for the next one. */
class Client {
  readonly frames: Array<Record<string, unknown>> = [];
  closed: { code: number } | null = null;
  private waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.frames.push(JSON.parse(data.toString()));
      this.wake();
    });
    ws.on('close', (code) => {
      this.closed = { code };
      this.wake();
    });
  }

  static open(url: string, headers: Record<string, string> = {}): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const client = new Client(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  hello(resume?: { streamId: string; seq: number }): void {
    this.send({
      type: 'hello',
      id: 'hello-1',
      payload: { protocol: PROTOCOL_VERSION, client: { name: 'test' }, ...(resume ? { resume } : {}) },
    });
  }

  /** Wait until some frame matches, and answer it. */
  async next(match: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    for (;;) {
      const found = this.frames.find(match);
      if (found) return found;
      if (this.closed) throw new Error(`closed ${this.closed.code} before a match`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async welcome(): Promise<Record<string, any>> {
    return (await this.next((f) => f.type === 'welcome')) as Record<string, any>;
  }

  async closedWith(): Promise<number> {
    for (;;) {
      if (this.closed) return this.closed.code;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}

describe('Chat protocol v2', () => {
  let server: Server;
  let url: string;
  const open: Client[] = [];

  const connect = async (headers?: Record<string, string>) => {
    const client = await Client.open(url, headers);
    open.push(client);
    return client;
  };

  beforeAll(async () => {
    server = createServer();
    webSocketGatewayService.initialize(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`;
  });

  beforeEach(() => {
    for (const client of open.splice(0)) client.ws.terminate();
    mockInbox.accept.mockReset();
    mockInbox.cancel.mockReset();
    mockInbox.cancel.mockResolvedValue(true);
    mockInbox.turns.mockReturnValue([]);
    mockTrackEvent.mockReset();
  });

  afterAll(async () => {
    for (const client of open.splice(0)) client.ws.terminate();
    webSocketGatewayService.closeAll();
    (webSocketGatewayService as unknown as { wss?: WebSocketServer }).wss?.close();
    await new Promise((resolve) => server.close(resolve));
  });

  describe('Scenario: the handshake', () => {
    it('answers hello with the stream position, the snapshot and who is connected', async () => {
      mockInbox.turns.mockReturnValue([{ threadId: THREAD, state: 'running' }]);
      const client = await connect({ 'x-forwarded-user': '<ada@example.com>' });
      client.hello();

      const welcome = await client.welcome();
      expect(welcome.payload).toMatchObject({
        protocol: PROTOCOL_VERSION,
        streamId: eventStreamService.streamId,
        seq: eventStreamService.seq,
        resumed: false,
        // The ingress gives an email, which is the id and the name. Brackets and
        // colons are stripped: it is shown, never parsed.
        you: { id: 'ada@example.com', name: 'ada@example.com' },
        snapshot: { turns: [{ threadId: THREAD, state: 'running' }] },
      });
    });

    it('takes the id and the decoded display name from their own headers', async () => {
      const client = await connect({
        'x-forwarded-user': 'ada@example.com',
        'x-forwarded-user-id': 'user-ada-1',
        'x-forwarded-user-display-name': 'Ada%20Lovelace%20%C3%85str%C3%B6m',
      });
      client.hello();
      expect((await client.welcome()).payload.you).toEqual({ id: 'user-ada-1', name: 'Ada Lovelace Åström' });
    });

    it('names the connection by x-forwarded-user when the display name does not decode', async () => {
      const client = await connect({
        'x-forwarded-user': 'ada@example.com',
        'x-forwarded-user-id': 'user-ada-1',
        'x-forwarded-user-display-name': '%E0%A4%A',
      });
      client.hello();
      expect((await client.welcome()).payload.you).toEqual({ id: 'user-ada-1', name: 'ada@example.com' });
    });

    it('names the connection by x-forwarded-user when the display name is empty once cleaned', async () => {
      const client = await connect({
        'x-forwarded-user': 'ada@example.com',
        'x-forwarded-user-display-name': '%3C%3E%20',
      });
      client.hello();
      expect((await client.welcome()).payload.you).toEqual({ id: 'ada@example.com', name: 'ada@example.com' });
    });

    it('names the connection by x-forwarded-user when the ingress gives an id and no display name', async () => {
      const client = await connect({ 'x-forwarded-user': 'ada@example.com', 'x-forwarded-user-id': 'user-ada-1' });
      client.hello();
      expect((await client.welcome()).payload.you).toEqual({ id: 'user-ada-1', name: 'ada@example.com' });
    });

    it('names the connection by its id when the ingress gives nothing else', async () => {
      const client = await connect({ 'x-forwarded-user-id': 'user-ada-1' });
      client.hello();
      expect((await client.welcome()).payload.you).toEqual({ id: 'user-ada-1', name: 'user-ada-1' });
    });

    it('cleans the display name and cuts it at 128 code points, never inside a surrogate pair', async () => {
      const client = await connect({
        'x-forwarded-user': 'ada@example.com',
        'x-forwarded-user-display-name': encodeURIComponent(`Ada\u0007 ${'😀'.repeat(200)}`),
      });
      client.hello();
      const { name } = (await client.welcome()).payload.you as { name: string };
      expect(name).toBe(`Ada ${'😀'.repeat(124)}`);
    });

    it('has no name for a connection the ingress did not name', async () => {
      const client = await connect();
      client.hello();
      expect((await client.welcome()).payload.you).toEqual({ id: null, name: null });
    });

    it('tells a client from before this protocol to update, and closes', async () => {
      const client = await connect();
      client.send({ type: 'chat', payload: { mode: 'followup', content: 'hi', threadId: THREAD } });

      expect(await client.next((f) => f.type === 'nack')).toMatchObject({
        payload: { code: 'protocol_unsupported' },
      });
      expect(await client.closedWith()).toBe(CLOSE_CODES.protocolUnsupported);
    });

    it('closes a client that names another protocol version', async () => {
      const client = await connect();
      client.send({ type: 'hello', id: 'h', payload: { protocol: 1, client: { name: 'old' } } });
      expect(await client.closedWith()).toBe(CLOSE_CODES.protocolUnsupported);
    });

    it('answers a hello sent twice once, and sends the stream once', async () => {
      const client = await connect();
      client.hello();
      client.send({ type: 'hello', id: 'hello-2', payload: { protocol: PROTOCOL_VERSION, client: { name: 'test' } } });

      await client.welcome();
      expect(await client.next((f) => f.re === 'hello-2')).toMatchObject({ type: 'nack', payload: { code: 'invalid' } });

      const entry = eventStreamService.publish({ type: 'turn', payload: { threadId: THREAD, state: 'running' } });
      await client.next((f) => f.seq === entry.seq);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(client.frames.filter((f) => f.type === 'welcome')).toHaveLength(1);
      expect(client.frames.filter((f) => f.seq === entry.seq)).toHaveLength(1);
      expect(client.closed).toBeNull();
    });

    it('ignores audio sent before hello', async () => {
      const client = await connect();
      client.ws.send(Buffer.alloc(960));
      client.hello();
      expect((await client.welcome()).type).toBe('welcome');
    });
  });

  describe('Scenario: the stream', () => {
    it('sends every event, numbered, to every client', async () => {
      const a = await connect();
      const b = await connect();
      a.hello();
      b.hello();
      await a.welcome();
      await b.welcome();

      const entry = eventStreamService.publish({ type: 'turn', payload: { threadId: THREAD, state: 'running' } });

      for (const client of [a, b]) {
        expect(await client.next((f) => f.seq === entry.seq)).toEqual({
          type: 'turn',
          seq: entry.seq,
          payload: { threadId: THREAD, state: 'running' },
        });
      }
    });

    it('sends a returning client exactly what it missed, then carries on live', async () => {
      const first = await connect();
      first.hello();
      const { streamId, seq } = (await first.welcome()).payload;
      first.ws.terminate();

      const missed = [
        eventStreamService.publish({ type: 'turn', payload: { threadId: THREAD, state: 'running' } }),
        eventStreamService.publish({ type: 'turn', payload: { threadId: THREAD, state: 'idle', outcome: 'completed' } }),
      ];

      const back = await connect();
      back.hello({ streamId, seq });
      const welcome = await back.welcome();
      expect(welcome.payload.resumed).toBe(true);
      expect(welcome.payload.seq).toBe(missed[1]!.seq);

      const live = eventStreamService.publish({ type: 'thread', payload: { threadId: THREAD, title: 'Hello' } });
      await back.next((f) => f.seq === live.seq);

      // The welcome, then the missed events in order, then the live one — nothing
      // twice and nothing out of order.
      expect(back.frames.map((f) => f.seq ?? f.type)).toEqual(['welcome', missed[0]!.seq, missed[1]!.seq, live.seq]);
    });

    it('reports the client of a new connection, and of one that came back', async () => {
      const first = await connect();
      first.hello();
      const { streamId, seq } = (await first.welcome()).payload;
      const back = await connect();
      back.hello({ streamId, seq });
      await back.welcome();

      expect(mockTrackEvent.mock.calls.map(([event, , properties]) => [event, properties['socket.client']])).toEqual([
        ['chat socket connected', 'test'],
        ['chat socket resumed', 'test'],
      ]);
    });

    it('tells a client with a cursor from another process to reload', async () => {
      eventStreamService.publish({ type: 'turn', payload: { threadId: THREAD, state: 'running' } });
      const client = await connect();
      client.hello({ streamId: 'a-previous-process', seq: 1 });

      const welcome = await client.welcome();
      expect(welcome.payload.resumed).toBe(false);
      // Nothing is replayed after a welcome that did not resume.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(client.frames).toHaveLength(1);
    });
  });

  describe('Scenario: requests', () => {
    async function ready(headers?: Record<string, string>): Promise<Client> {
      const client = await connect(headers);
      client.hello();
      await client.welcome();
      return client;
    }

    const send = (id = 'req-1', message: Record<string, unknown> = {}) => ({
      type: 'send',
      id,
      payload: { message: { id: MESSAGE, threadId: THREAD, content: 'hello', attachmentIds: [], ...message } },
    });

    it('confirms a stored message under the request id', async () => {
      mockInbox.accept.mockResolvedValue({ message: { id: MESSAGE }, seq: 7, queued: true, duplicate: false });
      const client = await ready({
        'x-forwarded-user': 'ada@example.com',
        'x-forwarded-user-id': 'user-ada-1',
        'x-forwarded-user-display-name': 'Ada%20Lovelace',
      });
      client.send(send());

      expect(await client.next((f) => f.re === 'req-1')).toEqual({
        type: 'ack',
        re: 'req-1',
        payload: { messageId: MESSAGE, seq: 7, queued: true, duplicate: false },
      });
      expect(mockInbox.accept).toHaveBeenCalledWith({
        id: MESSAGE,
        threadId: THREAD,
        content: 'hello',
        attachmentIds: [],
        sender: { id: 'user-ada-1', name: 'Ada Lovelace' },
      });
    });

    it('refuses a message the service refused, with its code', async () => {
      mockInbox.accept.mockRejectedValue(new MockInboundMessageError('id_conflict', 'taken'));
      const client = await ready();
      client.send(send());

      expect(await client.next((f) => f.re === 'req-1')).toMatchObject({
        type: 'nack',
        payload: { code: 'id_conflict' },
      });
    });

    it('refuses a message id that is not a uuid v4, without asking the service', async () => {
      const client = await ready();
      client.send(send('req-2', { id: 'local-123' }));

      expect(await client.next((f) => f.re === 'req-2')).toMatchObject({
        type: 'nack',
        payload: { code: 'invalid' },
      });
      expect(mockInbox.accept).not.toHaveBeenCalled();
    });

    it('refuses a message with neither text nor a file', async () => {
      const client = await ready();
      client.send(send('req-3', { content: '   ' }));
      expect(await client.next((f) => f.re === 'req-3')).toMatchObject({ type: 'nack', payload: { code: 'invalid' } });
    });

    it('cancels one conversation and confirms it', async () => {
      const client = await ready();
      client.send({ type: 'cancel', id: 'c-1', payload: { threadId: THREAD } });

      expect(await client.next((f) => f.re === 'c-1')).toEqual({ type: 'ack', re: 'c-1', payload: {} });
      expect(mockInbox.cancel).toHaveBeenCalledWith(THREAD);
    });

    it('refuses to cancel a conversation that is not the owner’s', async () => {
      mockInbox.cancel.mockRejectedValue(new MockInboundMessageError('unknown_thread', 'no such conversation'));
      const client = await ready();
      client.send({ type: 'cancel', id: 'c-2', payload: { threadId: THREAD } });
      expect(await client.next((f) => f.re === 'c-2')).toMatchObject({
        type: 'nack',
        payload: { code: 'unknown_thread' },
      });
    });

    it('answers a ping under its id', async () => {
      const client = await ready();
      client.send({ type: 'ping', id: 'p-1' });
      expect(await client.next((f) => f.re === 'p-1')).toEqual({ type: 'pong', re: 'p-1' });
    });

    it('tells a client over the rate when to try again, and keeps it connected', async () => {
      mockInbox.accept.mockResolvedValue({ message: { id: MESSAGE }, seq: 1, queued: false, duplicate: false });
      const client = await ready();
      for (let i = 0; i < 30; i++) client.send(send(`r-${i}`));

      const limited = await client.next((f) => f.type === 'nack' && (f.payload as any).code === 'rate_limited');
      expect((limited.payload as any).retryAfterMs).toBeGreaterThan(0);

      client.send({ type: 'ping', id: 'still-there' });
      expect(await client.next((f) => f.re === 'still-there')).toMatchObject({ type: 'pong' });
    });
  });

  describe('Scenario: the connection cap', () => {
    it('replaces the oldest connection rather than refusing a new one', async () => {
      const oldest = await connect();
      const rest = [];
      for (let i = 1; i < MAX_CONNECTIONS; i++) rest.push(await connect());

      const newest = await connect();
      expect(await oldest.closedWith()).toBe(CLOSE_CODES.replaced);

      newest.hello();
      expect((await newest.welcome()).type).toBe('welcome');
    });
  });
});
