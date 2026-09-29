/**
 * The bot port against the real Teams SDK: what an anonymous caller on the
 * internet can reach when a deployment publishes it. Only the messaging route
 * answers, and it answers 401 without a Bot Framework token.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type http from 'node:http';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    agentId: 'agent-1',
    teamsAppId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    teamsAppPassword: 'invented-secret',
    teamsAppTenantId: '11111111-2222-4333-8444-555555555555',
    host: '127.0.0.1',
    teamsPort: 0,
    port: 3003,
    publicUrl: null,
  },
}));

vi.mock('../../../config', () => ({ config: mockConfig }));
vi.mock('../../../lib/prisma', () => ({ default: {}, prisma: {} }));
vi.mock('../../../lib/telemetry', () => ({ trackEvent: vi.fn() }));
vi.mock('../../../lib/teams-config', () => ({
  getTeamsConfig: vi.fn().mockResolvedValue({
    id: '11111111-2222-4333-8444-555555555555',
    tenantId: '11111111-2222-4333-8444-555555555555',
    clientId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    name: 'Microsoft Teams',
  }),
}));
vi.mock('../../conversation.service', () => ({ conversationService: {} }));
vi.mock('../../conversation-engine.service', () => ({ conversationEngineService: {} }));

import { teamsAdapterService } from '../teams-adapter.service';

describe('the Teams bot port', () => {
  let base = '';

  beforeAll(async () => {
    // Bind port 0 and read back what the OS assigned: binding takes the port in
    // one step, so no other worker can take it between a probe and the bind.
    mockConfig.teamsPort = 0;
    await teamsAdapterService.initialize();
    const server = (teamsAdapterService as unknown as { server?: http.Server }).server;
    const address = server?.address();
    if (!address || typeof address === 'string') {
      throw new Error('Teams bot server did not bind a port');
    }
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await teamsAdapterService.shutdown();
  });

  it('rejects a message without a Bot Framework token', async () => {
    const res = await fetch(`${base}/agents/teams/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'message', text: 'hello' }),
    });

    expect(res.status).toBe(401);
  });

  it.each([
    ['GET', '/'],
    ['GET', '/agents/teams/messages'],
    ['GET', '/agents/me'],
    ['POST', '/agents/chat'],
    ['GET', '/health'],
  ])('answers %s %s with 404', async (method, path) => {
    const res = await fetch(`${base}${path}`, { method });

    expect(res.status).toBe(404);
  });
});
