import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { trackEvent } from '../lib/telemetry';
import { computerWindowRouter } from './computer-window';

vi.mock('../lib/telemetry', () => ({ trackEvent: vi.fn() }));
vi.mock('../config', () => ({ config: { agentId: 'test-agent', ownerUserId: 'test-user' } }));
const app = express().use(express.json()).use('/agents', computerWindowRouter);

describe('Computer window telemetry', () => {
  it.each(['opened', 'closed', 'blocked'])(
    'records the %s outcome with runtime identity',
    async (status) => {
      await request(app)
        .post('/agents/computer-window/events')
        .send({ status, userId: 'untrusted', content: 'private' })
        .expect(204);
      expect(trackEvent).toHaveBeenCalledExactlyOnceWith(`computer window ${status}`, 'test-user', {
        agent_id: 'test-agent',
      });
    },
  );
  it('rejects unknown events', async () => {
    await request(app)
      .post('/agents/computer-window/events')
      .send({ status: 'arbitrary' })
      .expect(400);
    expect(trackEvent).not.toHaveBeenCalled();
  });
});
