import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net, { type AddressInfo } from 'node:net';
import { once } from 'node:events';

const { getAgent, updateAgent, trackEvent } = vi.hoisted(() => ({
  getAgent: vi.fn(), updateAgent: vi.fn(), trackEvent: vi.fn(),
}));
vi.mock('./agent-workspace.service', () => ({ agentWorkspaceService: { getAgent } }));
vi.mock('../lib/prisma', () => ({ prisma: { agentWorkspace: { update: updateAgent } } }));
vi.mock('../lib/telemetry', () => ({ trackEvent }));
vi.mock('./webhook.service', () => ({ webhookService: { handleInbound: vi.fn() } }));

import { config } from '../config';
import { WebhookReceiverService } from './webhook-receiver.service';

let receiver: WebhookReceiverService;
let enabled: boolean;
let port: number;
const originalPort = config.webhookPort;
const originalHost = config.host;

async function reservePort(): Promise<net.Server> {
  const server = net.createServer();
  server.listen(port || 0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function expectPortClosed() {
  const socket = net.createConnection(port, '127.0.0.1');
  const [error] = await once(socket, 'error');
  expect(error.code).toBe('ECONNREFUSED');
  const reservation = await reservePort();
  await close(reservation);
}

beforeEach(async () => {
  enabled = false;
  port = 0;
  const reservation = await reservePort();
  port = (reservation.address() as AddressInfo).port;
  await close(reservation);
  Object.assign(config, { webhookPort: port, host: '127.0.0.1' });
  getAgent.mockImplementation(async () => ({ id: 'agent-1', userId: 'user-1', webhooksEnabled: enabled }));
  updateAgent.mockImplementation(async ({ data }) => { enabled = data.webhooksEnabled; });
  receiver = new WebhookReceiverService();
});

afterEach(async () => {
  await receiver.shutdown();
  Object.assign(config, { webhookPort: originalPort, host: originalHost });
});

describe('webhook receiver listener', () => {
  it('leaves the port closed when the saved setting is disabled', async () => {
    await receiver.initialize();
    expect(receiver.enabled).toBe(false);
    await expectPortClosed();
  });

  it('opens on enable and closes existing connections on disable', async () => {
    await receiver.setEnabled(true);
    expect(enabled).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(404);
    const socket = net.createConnection(port, '127.0.0.1');
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    socket.write('POST /agents/webhooks/alerts HTTP/1.1\r\n');
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await receiver.setEnabled(false);
    await closed;
    expect(enabled).toBe(false);
    expect(receiver.enabled).toBe(false);
    await expectPortClosed();
  });

  it('restores an enabled receiver after restart and preserves the setting on shutdown', async () => {
    await receiver.setEnabled(true);
    await receiver.shutdown();
    expect(enabled).toBe(true);
    await expectPortClosed();
    receiver = new WebhookReceiverService();
    await receiver.initialize();
    expect(receiver.enabled).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(404);
  });

  it('serializes overlapping enable and disable requests', async () => {
    await Promise.all([
      receiver.setEnabled(true), receiver.setEnabled(false), receiver.setEnabled(true),
    ]);
    expect(receiver.enabled).toBe(true);
    expect(enabled).toBe(true);
    await receiver.setEnabled(false);
    await expectPortClosed();
  });

  it('keeps a taken port disabled and allows a later enable attempt', async () => {
    const reservation = await reservePort();
    try {
      await expect(receiver.setEnabled(true)).rejects.toThrow('already in use');
      expect(enabled).toBe(false);
      expect(receiver.enabled).toBe(false);
      expect(trackEvent).toHaveBeenCalledWith('webhook receiver toggle failed', 'user-1', {
        'agent.id': 'agent-1', 'webhook.operation': 'enable',
      });
    } finally {
      await close(reservation);
    }
    await receiver.setEnabled(true);
    expect(receiver.enabled).toBe(true);
  });

  it('disables the saved receiver when its port cannot open at startup', async () => {
    enabled = true;
    const reservation = await reservePort();
    try {
      await receiver.initialize();
      expect(enabled).toBe(false);
      expect(receiver.enabled).toBe(false);
    } finally {
      await close(reservation);
    }
  });

  it('closes the port if saving the enabled setting fails', async () => {
    updateAgent.mockRejectedValue(new Error('Database unavailable'));
    await expect(receiver.setEnabled(true)).rejects.toThrow('Database unavailable');
    expect(receiver.enabled).toBe(false);
    await expectPortClosed();
  });

  it('keeps the listener open if saving the disabled setting fails', async () => {
    await receiver.setEnabled(true);
    updateAgent.mockRejectedValue(new Error('Database unavailable'));
    await expect(receiver.setEnabled(false)).rejects.toThrow('Database unavailable');
    expect(receiver.enabled).toBe(true);
    expect(enabled).toBe(true);
  });

  it('rejects enable requests after shutdown', async () => {
    await receiver.shutdown();
    await expect(receiver.setEnabled(true)).rejects.toThrow('shutting down');
    await expectPortClosed();
  });
});
