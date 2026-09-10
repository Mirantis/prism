/**
 * The one place that decides which endpoint an upgrade belongs to.
 *
 * The rule worth pinning is the one no endpoint can enforce alone: an upgrade to a path
 * nobody serves is closed. Each handler knows only its own path, so ignoring an unknown
 * one leaves its socket open for as long as the client holds it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';

vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { serveUpgrades, resetUpgrades } = await import('../websocket-upgrades');

/** A socket that records whether it was closed. */
function fakeSocket() {
  return { destroy: vi.fn() } as unknown as Duplex & { destroy: ReturnType<typeof vi.fn> };
}

function upgrade(server: EventEmitter, url: string) {
  const socket = fakeSocket();
  server.emit('upgrade', { url } as IncomingMessage, socket, Buffer.alloc(0));
  return socket;
}

describe('serveUpgrades', () => {
  let server: EventEmitter;

  beforeEach(() => {
    resetUpgrades();
    server = new EventEmitter();
  });

  it('hands an upgrade to the endpoint that serves its path', () => {
    const chat = vi.fn();
    const voice = vi.fn();
    serveUpgrades(server as unknown as HttpServer, '/api/ws', chat);
    serveUpgrades(server as unknown as HttpServer, '/api/voice', voice);

    const socket = upgrade(server, '/api/voice');

    expect(voice).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('closes an upgrade to a path nobody serves', () => {
    serveUpgrades(server as unknown as HttpServer, '/api/ws', vi.fn());

    // Left open, this is a socket per request and a client can ask as often as it likes.
    expect(upgrade(server, '/nope').destroy).toHaveBeenCalled();
  });

  it('reads the path off a URL that carries a query', () => {
    const chat = vi.fn();
    serveUpgrades(server as unknown as HttpServer, '/api/ws', chat);

    upgrade(server, '/api/ws?token=abc');

    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('routes a dotted path by where it resolves, as the server would serve it', () => {
    const chat = vi.fn();
    const voice = vi.fn();
    serveUpgrades(server as unknown as HttpServer, '/api/ws', chat);
    serveUpgrades(server as unknown as HttpServer, '/api/voice', voice);

    upgrade(server, '/api/ws/../voice');

    // Both are the runtime's own endpoints, so there is nothing to reach this way that a
    // client could not ask for plainly. Matching the raw string instead would close a
    // request the endpoint would otherwise have served.
    expect(voice).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
  });

  it('listens once however many endpoints register', () => {
    serveUpgrades(server as unknown as HttpServer, '/api/ws', vi.fn());
    serveUpgrades(server as unknown as HttpServer, '/api/voice', vi.fn());

    // A listener per endpoint would close each other's sockets, since each would find no
    // handler for the other's path.
    expect(server.listenerCount('upgrade')).toBe(1);
  });
});
