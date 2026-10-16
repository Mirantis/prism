/**
 * Computer Handshake Origin Tests
 *
 * A real handshake against the computer endpoint, which applies the rules in
 * `lib/origin-guard.ts` to its own WebSocket upgrade.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { allowing, boundTo } from '../../../test-utils/origin-config';
import { COMPUTER_PATH, computerEndpoint } from '../computer-endpoint';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../computer.service', () => {
  const events = new EventEmitter();
  const session = {
    id: 'local',
    attach: async () => () => {},
    detach: () => {},
    input: () => {},
    status: () => ({ running: true }),
  };
  return {
    LOCAL_COMPUTER_ID: 'local',
    computerService: {
      on: (event: string, listener: () => void) => events.on(event, listener),
      off: (event: string, listener: () => void) => events.off(event, listener),
      session: () => session,
      summaries: () => [],
    },
  };
});

function handshake(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    let settled = false;
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

describe('computer handshake origin rules', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer();
    computerEndpoint.initialize(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${COMPUTER_PATH}`;
  });

  afterAll(async () => {
    computerEndpoint.close();
    await new Promise((resolve) => server.close(resolve));
  });

  // The production shape: the list is set only on a widened bind.
  beforeEach(() => boundTo('0.0.0.0'));

  afterEach(() => {
    boundTo('127.0.0.1');
    allowing('');
  });

  it('opens for a listed origin', async () => {
    allowing('https://app.example.com:*');
    expect(await handshake(url, { Origin: 'https://app.example.com:4444' })).toBe('open');
  });

  it('refuses an unlisted foreign origin with 403', async () => {
    allowing('https://app.example.com:*');
    expect(await handshake(url, { Origin: 'https://evil.example' })).toBe('refused 403');
  });
});
