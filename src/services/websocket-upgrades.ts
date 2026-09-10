/**
 * Which WebSocket endpoint an upgrade belongs to.
 *
 * Two endpoints share the runtime's HTTP server: chat on `/api/ws` and a voice chat with
 * a computer on `/api/voice`. A `ws` server bound with `path` answers every other path's
 * upgrade with a 400, which is why each takes `noServer` and picks its own off the
 * server's event instead.
 *
 * That leaves one thing neither of them can decide alone: an upgrade to a path nobody
 * serves. A handler that only knows its own path can only ignore it, and an ignored
 * upgrade holds its socket open for as long as the client keeps it. So the decision is
 * made once, here, by the only party that knows every path.
 */

import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { logger } from '../logger';

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

const handlers = new Map<string, UpgradeHandler>();
/** The listener this module installed, held so a reset can take it off again. */
let installed: { server: HttpServer; listener: UpgradeHandler } | null = null;

function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://localhost').pathname;
}

/**
 * Serve WebSocket upgrades on `path` with `handler`.
 *
 * The first call starts listening on the server. Registering a path twice replaces the
 * handler, so a restart in a test does not stack them.
 */
export function serveUpgrades(server: HttpServer, path: string, handler: UpgradeHandler): void {
  handlers.set(path, handler);
  if (installed) return;
  const listener: UpgradeHandler = (req, socket, head) => {
    const handle = handlers.get(pathnameOf(req));
    if (handle) {
      handle(req, socket, head);
      return;
    }
    logger.debug(`Refused a WebSocket upgrade to ${req.url ?? ''}`);
    socket.destroy();
  };
  installed = { server, listener };
  server.on('upgrade', listener);
}

/** Forget every registered path and stop listening. For tests, which build a server per case. */
export function resetUpgrades(): void {
  handlers.clear();
  installed?.server.off('upgrade', installed.listener);
  installed = null;
}
