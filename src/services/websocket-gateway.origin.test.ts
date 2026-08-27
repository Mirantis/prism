/**
 * WebSocket Handshake Origin Tests
 *
 * A real handshake against the real gateway: the `/api/ws` upgrade is the one
 * surface a browser can open cross-site without a preflight, so the rules in
 * `lib/origin-guard.ts` are tested here as they are wired.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { webSocketGatewayService } from './websocket-gateway.service';

function handshake(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    let settled = false;
    // The error listener stays attached: `ws` reports a refused handshake as
    // an `unexpected-response` and then as an error on the dead socket.
    const settle = (verdict: string) => {
      if (settled) return;
      settled = true;
      resolve(verdict);
    };
    ws.on('open', () => {
      settle('open');
      ws.close();
    });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      settle(`refused ${res.statusCode}`);
      ws.terminate();
    });
    ws.on('error', (err) => settle(`error ${err.message}`));
  });
}

describe('WebSocket handshake origin rules', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer();
    webSocketGatewayService.initialize(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`;
  });

  afterAll(async () => {
    webSocketGatewayService.closeAll();
    // The gateway's liveness interval clears on the WebSocket server's own
    // close event, which `server.close()` does not raise.
    (webSocketGatewayService as unknown as { wss?: WebSocketServer }).wss?.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it('opens for a client that states no origin', async () => {
    expect(await handshake(url, {})).toBe('open');
  });

  it('opens for a loopback origin', async () => {
    expect(await handshake(url, { Origin: 'http://localhost:5173' })).toBe('open');
  });

  it('refuses a foreign origin with 403', async () => {
    expect(await handshake(url, { Origin: 'https://evil.example' })).toBe('refused 403');
  });

  it('refuses the literal null origin a sandboxed page sends', async () => {
    expect(await handshake(url, { Origin: 'null' })).toBe('refused 403');
  });

  it('refuses a rebound host, where page and request agree on a foreign name', async () => {
    const port = (server.address() as AddressInfo).port;
    const verdict = await handshake(url, {
      Host: `evil.example:${port}`,
      Origin: `http://evil.example:${port}`,
    });
    expect(verdict).toBe('refused 403');
  });
});
