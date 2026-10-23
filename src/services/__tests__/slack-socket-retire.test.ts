/**
 * Retiring a Socket Mode app, against the real `SocketModeReceiver` and its
 * `SocketModeClient` over loopback WebSockets. The two cases are the reconnect
 * states that a rebuild, a shutdown and a disconnect stop.
 */

import net from 'node:net';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { LogLevel, SocketModeReceiver } from '@slack/bolt';
import type { FetchFunction } from '@slack/web-api';
import { retirableFetch, retireSocketApp } from '../slack-socket-retire';

/** The reconnect delay is this times the failure count, and pings run at a third of it. */
const PING_TIMEOUT_MS = 300;

describe('Requirement: a retired Socket Mode app opens no socket and does not end the process', () => {
  let slack: WebSocketServer;
  let silent: net.Server;
  let sockets: WebSocket[];
  let receiver: SocketModeReceiver | undefined;
  const unhandled = vi.fn();

  const portOf = (server: { address(): unknown }): number => (server.address() as net.AddressInfo).port;
  const until = (event: string): Promise<void> =>
    new Promise<void>((resolve) => receiver!.client.once(event, () => resolve()));
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(async () => {
    sockets = [];
    slack = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    slack.on('connection', (socket) => {
      sockets.push(socket);
      socket.send(JSON.stringify({ type: 'hello' }));
    });
    // Accepts TCP and never answers the WebSocket upgrade.
    silent = net.createServer(() => {});
    await Promise.all([
      new Promise<void>((resolve) => slack.once('listening', () => resolve())),
      new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve())),
    ]);
    process.on('unhandledRejection', unhandled);
  });

  afterEach(async () => {
    process.off('unhandledRejection', unhandled);
    unhandled.mockReset();
    await receiver?.stop();
    receiver = undefined;
    for (const socket of slack.clients) socket.terminate();
    await new Promise((resolve) => slack.close(resolve));
    await new Promise((resolve) => silent.close(resolve));
  });

  /** Starts a real receiver whose second `apps.connections.open` gets `reconnect`'s answer. */
  async function connectThenDrop(reconnect: () => Promise<Response>) {
    let opens = 0;
    const answer: FetchFunction = async () => {
      opens += 1;
      return opens === 1 ? Response.json({ ok: true, url: `ws://127.0.0.1:${portOf(slack)}/` }) : reconnect();
    };
    const socketFetch = retirableFetch(answer);
    receiver = new SocketModeReceiver({
      appToken: 'xapp-invented',
      logLevel: LogLevel.ERROR,
      clientPingTimeout: PING_TIMEOUT_MS,
      installerOptions: { clientOptions: { fetch: socketFetch.fetch } },
    });
    await receiver.start();
    // Drop the socket without a close handshake, as a dead network does.
    (sockets[0] as unknown as { _socket: net.Socket })._socket.destroy();
    return socketFetch;
  }

  it('retires a client whose new socket waits for hello', async () => {
    const socketFetch = await connectThenDrop(async () =>
      Response.json({ ok: true, url: `ws://127.0.0.1:${portOf(silent)}/` }),
    );
    await until('connecting');

    await retireSocketApp(receiver!, receiver!.client, socketFetch.retire);
    await wait(3 * PING_TIMEOUT_MS);

    expect(unhandled).not.toHaveBeenCalled();
  });

  it('retires a client whose apps.connections.open answers after the stop', async () => {
    let answerLate!: () => void;
    const socketFetch = await connectThenDrop(
      () =>
        new Promise<Response>((resolve) => {
          answerLate = () => resolve(Response.json({ ok: true, url: `ws://127.0.0.1:${portOf(slack)}/` }));
        }),
    );
    await until('reconnecting');

    await retireSocketApp(receiver!, receiver!.client, socketFetch.retire);
    answerLate();
    await wait(3 * PING_TIMEOUT_MS);

    expect(sockets).toHaveLength(1);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('Requirement: a retired fetch answers nothing', () => {
  const settle = (): Promise<string> => new Promise((resolve) => setImmediate(() => resolve('pending')));

  it('passes requests through until it is retired', async () => {
    const response = Response.json({ ok: true });
    const socketFetch = retirableFetch(async () => response);

    expect(await socketFetch.fetch('https://slack.com/api/apps.connections.open')).toBe(response);
  });

  it('holds a request that answers or fails after the retire', async () => {
    let answer!: (response: Response) => void;
    let fail!: (error: Error) => void;
    const socketFetch = retirableFetch((url) =>
      String(url).endsWith('/ok')
        ? new Promise<Response>((resolve) => (answer = resolve))
        : new Promise<Response>((_, reject) => (fail = reject)),
    );
    const answered = socketFetch.fetch('https://slack.com/api/ok');
    const failed = socketFetch.fetch('https://slack.com/api/fail');

    socketFetch.retire();
    answer(Response.json({ ok: true }));
    fail(new Error('fetch failed'));

    expect(await Promise.race([answered, settle()])).toBe('pending');
    expect(await Promise.race([failed, settle()])).toBe('pending');
    expect(await Promise.race([socketFetch.fetch('https://slack.com/api/ok'), settle()])).toBe('pending');
  });
});
