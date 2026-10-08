/**
 * Slack route tests: the Slack heartbeat triggers, the link codes and mappings,
 * and the thread an external Slack thread id is bound to.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Prisma } from '@prisma/client';

const {
  mockPrisma,
  mockSlackHeartbeatTriggerService,
  mockSlackMappingService,
  mockGetOrCreateThreadByExternalId,
  mockTrackEvent,
} = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
    slackVerificationCode: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    slackMapping: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  mockSlackHeartbeatTriggerService: {
    isHeartbeatTriggerChannel: vi.fn(),
    getActiveTriggers: vi.fn(),
    createTrigger: vi.fn(),
    updateThrottle: vi.fn(),
    deleteTrigger: vi.fn(),
    tryClaimTrigger: vi.fn(),
  },
  mockSlackMappingService: {
    setMainChannel: vi.fn(),
    getMainChannel: vi.fn(),
  },
  mockGetOrCreateThreadByExternalId: vi.fn(),
  mockTrackEvent: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock('../services/slack-heartbeat-trigger.service', () => ({
  slackHeartbeatTriggerService: mockSlackHeartbeatTriggerService,
}));
vi.mock('../services/slack-mapping.service', () => ({ slackMappingService: mockSlackMappingService }));
vi.mock('../services/conversation.service', () => ({
  conversationService: { getOrCreateThreadByExternalId: mockGetOrCreateThreadByExternalId },
}));
vi.mock('../services/heartbeat.service', () => ({ heartbeatService: { triggerFrom: vi.fn() } }));
vi.mock('../services/conversation-engine.service', () => ({ conversationEngineService: { chat: vi.fn() } }));
vi.mock('../invoke', () => ({ invoke: vi.fn() }));
vi.mock('../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
  isTelemetryEnabled: () => false,
}));

// eslint-disable-next-line import/first
import { slackRouter } from './slack';
// eslint-disable-next-line import/first
import { slackAdapterService } from '../services/slack-adapter.service';

/** The Slack routes carry no auth of their own; the header is harmless. */
function authedRequest(app: express.Express) {
  return {
    post: (url: string) => request(app).post(url).set('Authorization', 'Bearer test-secret'),
    get: (url: string) => request(app).get(url).set('Authorization', 'Bearer test-secret'),
    patch: (url: string) => request(app).patch(url).set('Authorization', 'Bearer test-secret'),
    put: (url: string) => request(app).put(url).set('Authorization', 'Bearer test-secret'),
    delete: (url: string) => request(app).delete(url).set('Authorization', 'Bearer test-secret'),
  };
}

describe('slack routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/agents', slackRouter);
  });

  // ==========================================================================
  // Slack Heartbeat Trigger Management
  // ==========================================================================

  describe('GET /slack-heartbeat-trigger/channel/:channelId', () => {
    it('returns isTrigger result for a channel', async () => {
      mockSlackHeartbeatTriggerService.isHeartbeatTriggerChannel.mockResolvedValueOnce({
        isTrigger: true,
        userId: 'user-1',
        agentId: 'agent-1',
      });

      const res = await authedRequest(app)
        .get('/agents/slack-heartbeat-trigger/channel/C123');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ isTrigger: true, userId: 'user-1', agentId: 'agent-1' });
      expect(mockSlackHeartbeatTriggerService.isHeartbeatTriggerChannel).toHaveBeenCalledWith('C123');
    });

    it('returns 500 when service throws', async () => {
      mockSlackHeartbeatTriggerService.isHeartbeatTriggerChannel.mockRejectedValueOnce(
        new Error('DB error'),
      );

      const res = await authedRequest(app)
        .get('/agents/slack-heartbeat-trigger/channel/C123');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  describe('GET /slack-heartbeat-trigger', () => {
    it('returns 400 when userId query param is missing', async () => {
      const res = await authedRequest(app)
        .get('/agents/slack-heartbeat-trigger');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('userId');
    });

    it('returns active triggers for the agent', async () => {
      const triggers = [{ id: 'trigger-1', agentId: 'agent-1', slackChannelId: 'C123' }];
      mockSlackHeartbeatTriggerService.getActiveTriggers.mockResolvedValueOnce(triggers);

      const res = await authedRequest(app)
        .get('/agents/slack-heartbeat-trigger?userId=user-1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(triggers);
      expect(mockSlackHeartbeatTriggerService.getActiveTriggers).toHaveBeenCalledWith('user-1');
    });

    it('returns 500 when service throws', async () => {
      mockSlackHeartbeatTriggerService.getActiveTriggers.mockRejectedValueOnce(
        new Error('DB error'),
      );

      const res = await authedRequest(app)
        .get('/agents/slack-heartbeat-trigger?userId=user-1');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  describe('POST /slack-heartbeat-trigger', () => {
    it('returns 400 when required fields are missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/slack-heartbeat-trigger')
        .send({ connectionId: 'conn-1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('connectionId');
    });

    it('creates a trigger and returns 201', async () => {
      const trigger = {
        id: 'trigger-new',
        connectionId: 'conn-1',
        slackChannelId: 'C123',
        agentId: 'agent-1',
      };
      mockSlackHeartbeatTriggerService.createTrigger.mockResolvedValueOnce(trigger);

      const res = await authedRequest(app)
        .post('/agents/slack-heartbeat-trigger')
        .send({
          connectionId: 'conn-1',
          channelId: 'C123',
          channelName: 'general',
          userId: 'user-1',
          throttleSeconds: 300,
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(trigger);
      expect(mockSlackHeartbeatTriggerService.createTrigger).toHaveBeenCalledWith(
        'conn-1', 'C123', 'general', 'user-1', 300,
      );
    });

    it('passes null channelName when omitted', async () => {
      mockSlackHeartbeatTriggerService.createTrigger.mockResolvedValueOnce({ id: 'trigger-new' });

      await authedRequest(app)
        .post('/agents/slack-heartbeat-trigger')
        .send({ connectionId: 'conn-1', channelId: 'C123', userId: 'user-1' });

      expect(mockSlackHeartbeatTriggerService.createTrigger).toHaveBeenCalledWith(
        'conn-1', 'C123', null, 'user-1', undefined,
      );
    });

    it('returns 500 when service throws', async () => {
      mockSlackHeartbeatTriggerService.createTrigger.mockRejectedValueOnce(
        new Error('Unique constraint'),
      );

      const res = await authedRequest(app)
        .post('/agents/slack-heartbeat-trigger')
        .send({ connectionId: 'conn-1', channelId: 'C123', userId: 'user-1' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Unique constraint');
    });
  });

  describe('PATCH /slack-heartbeat-trigger', () => {
    it('returns 400 when required fields are missing', async () => {
      const res = await authedRequest(app)
        .patch('/agents/slack-heartbeat-trigger')
        .send({ triggerId: 'trigger-1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('triggerId');
    });

    it('updates throttle and returns the updated trigger', async () => {
      const updated = { id: 'trigger-1', throttleSeconds: 600 };
      mockSlackHeartbeatTriggerService.updateThrottle.mockResolvedValueOnce(updated);

      const res = await authedRequest(app)
        .patch('/agents/slack-heartbeat-trigger')
        .send({ triggerId: 'trigger-1', userId: 'user-1', throttleSeconds: 600 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);
      expect(mockSlackHeartbeatTriggerService.updateThrottle).toHaveBeenCalledWith(
        'trigger-1', 'user-1', 600,
      );
    });

    it('returns 404 when trigger is not found', async () => {
      mockSlackHeartbeatTriggerService.updateThrottle.mockResolvedValueOnce(null);

      const res = await authedRequest(app)
        .patch('/agents/slack-heartbeat-trigger')
        .send({ triggerId: 'trigger-missing', userId: 'user-1', throttleSeconds: 600 });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('returns 500 when service throws', async () => {
      mockSlackHeartbeatTriggerService.updateThrottle.mockRejectedValueOnce(
        new Error('DB error'),
      );

      const res = await authedRequest(app)
        .patch('/agents/slack-heartbeat-trigger')
        .send({ triggerId: 'trigger-1', userId: 'user-1', throttleSeconds: 600 });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  describe('DELETE /slack-heartbeat-trigger/:id', () => {
    it('returns 400 when userId query param is missing', async () => {
      const res = await authedRequest(app)
        .delete('/agents/slack-heartbeat-trigger/trigger-1');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('userId');
    });

    it('deletes the trigger and returns success', async () => {
      mockSlackHeartbeatTriggerService.deleteTrigger.mockResolvedValueOnce(undefined);

      const res = await authedRequest(app)
        .delete('/agents/slack-heartbeat-trigger/trigger-1?userId=user-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSlackHeartbeatTriggerService.deleteTrigger).toHaveBeenCalledWith('trigger-1', 'user-1');
    });

    it('returns 500 when service throws', async () => {
      mockSlackHeartbeatTriggerService.deleteTrigger.mockRejectedValueOnce(
        new Error('DB error'),
      );

      const res = await authedRequest(app)
        .delete('/agents/slack-heartbeat-trigger/trigger-1?userId=user-1');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  describe('POST /slack-heartbeat-trigger/claim', () => {
    it('returns claimed result', async () => {
      mockSlackHeartbeatTriggerService.tryClaimTrigger.mockResolvedValueOnce({ claimed: true });

      const res = await authedRequest(app)
        .post('/agents/slack-heartbeat-trigger/claim')
        .send();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ claimed: true });
      expect(mockSlackHeartbeatTriggerService.tryClaimTrigger).toHaveBeenCalledWith();
    });

    it('returns throttled result with remaining seconds', async () => {
      mockSlackHeartbeatTriggerService.tryClaimTrigger.mockResolvedValueOnce({
        claimed: false,
        remainingSeconds: 120,
      });

      const res = await authedRequest(app)
        .post('/agents/slack-heartbeat-trigger/claim')
        .send();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ claimed: false, remainingSeconds: 120 });
    });

    it('returns 500 when service throws', async () => {
      mockSlackHeartbeatTriggerService.tryClaimTrigger.mockRejectedValueOnce(
        new Error('DB error'),
      );

      const res = await authedRequest(app)
        .post('/agents/slack-heartbeat-trigger/claim')
        .send();

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  // ==========================================================================
  // POST /slack/verify-channel-link-code
  // ==========================================================================

  describe('POST /slack/verify-channel-link-code', () => {
    it('returns 400 when code is missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/slack/verify-channel-link-code')
        .send({ channelId: 'C789' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('code');
    });

    it('returns 400 when channelId is missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/slack/verify-channel-link-code')
        .send({ code: 'AAAAAA' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('channelId');
    });

    it('returns failure for non-existent code', async () => {
      mockPrisma.slackVerificationCode.findUnique.mockResolvedValue(null);

      const res = await authedRequest(app)
        .post('/agents/slack/verify-channel-link-code')
        .send({ code: 'ZZZZZZ', channelId: 'C789' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('That code is not valid. Generate a new code in Prism Agent, under Settings → Channels.');
    });

    it('returns failure for expired code', async () => {
      mockPrisma.slackVerificationCode.findUnique.mockResolvedValue({
        id: 'vc-002',
        code: 'AAAAAA',
        type: 'CHANNEL',
        lensUserId: 'user-001',
        connectionId: 'conn-001',
        agentId: 'agent-001',
        agentName: 'Test Agent',
        expiresAt: new Date(Date.now() - 60 * 1000),
        createdAt: new Date(),
      });
      mockPrisma.slackVerificationCode.delete.mockResolvedValue({});

      const res = await authedRequest(app)
        .post('/agents/slack/verify-channel-link-code')
        .send({ code: 'AAAAAA', channelId: 'C789' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('That code has expired. Generate a new code in Prism Agent, under Settings → Channels.');
    });

    it('normalizes codes to uppercase', async () => {
      mockPrisma.slackVerificationCode.findUnique.mockResolvedValue(null);

      const res = await authedRequest(app)
        .post('/agents/slack/verify-channel-link-code')
        .send({ code: 'abcdef', channelId: 'C789' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(mockPrisma.slackVerificationCode.findUnique).toHaveBeenCalledWith({
        where: { code_type: { code: 'ABCDEF', type: 'CHANNEL' } },
      });
    });

    it('returns failure when channel is already linked', async () => {
      mockPrisma.slackVerificationCode.findUnique.mockResolvedValue({
        id: 'vc-004',
        code: 'DDD444',
        type: 'CHANNEL',
        lensUserId: 'user-001',
        connectionId: 'conn-001',
        agentId: 'agent-001',
        agentName: 'Test Agent',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        createdAt: new Date(),
      });
      mockPrisma.slackMapping.findUnique.mockResolvedValue({
        id: 'mapping-existing',
        slackChannelId: 'C789',
        agentId: 'agent-002',
      });

      const res = await authedRequest(app)
        .post('/agents/slack/verify-channel-link-code')
        .send({ code: 'DDD444', channelId: 'C789', channelName: 'general' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('already linked');
    });

    it('atomically creates channel mapping and deletes code on success', async () => {
      mockPrisma.slackVerificationCode.findUnique.mockResolvedValue({
        id: 'vc-005',
        code: 'EEE555',
        type: 'CHANNEL',
        lensUserId: 'user-001',
        connectionId: 'conn-001',
        agentId: 'agent-001',
        agentName: 'Test Agent',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        createdAt: new Date(),
      });
      mockPrisma.slackMapping.findUnique.mockResolvedValue(null);
      mockPrisma.slackMapping.create.mockResolvedValue({
        id: 'mapping-new',
        connectionId: 'conn-001',
        agentId: 'agent-001',
        slackChannelId: 'C789',
        slackChannelName: 'general',
        lensUserId: 'user-001',
      });
      mockPrisma.slackVerificationCode.delete.mockResolvedValue({});

      const res = await authedRequest(app)
        .post('/agents/slack/verify-channel-link-code')
        .send({ code: 'EEE555', channelId: 'C789', channelName: 'general' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Your Slack channel is now linked. Mention me anytime you need help!');
      expect(res.body.agentName).toBe('Test Agent');
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.slackMapping.create).toHaveBeenCalledWith({
        data: {
          connectionId: 'conn-001',
          agentId: 'agent-001',
          slackChannelId: 'C789',
          slackChannelName: 'general',
          lensUserId: 'user-001',
          slackUserId: null,
          dmChannelId: null,
        },
      });
    });
  });

  // ==========================================================================
  // Slack mapping read/delete routes — legacy connectionId regression
  //
  // Agents migrated from the old multi-tenant world carry a UUID connectionId
  // on their slack_mappings rows, while the runtime now identifies its one
  // connection by the Slack teamId. These routes must NOT filter by
  // connectionId, or those legacy mappings vanish from the UI (AGENT-74).
  // ==========================================================================

  const LEGACY_CONNECTION_ID = 'c85e8ac7-2a5c-4b6c-90b7-65cb477389bd';

  describe('GET /slack-channel-mappings', () => {
    it('lists channel mappings regardless of their stored connectionId', async () => {
      mockPrisma.slackMapping.findMany.mockResolvedValue([
        {
          id: 'm-1',
          slackChannelId: 'C03PSDNTYDT',
          slackChannelName: 'lens-support',
          connectionId: LEGACY_CONNECTION_ID,
          createdAt: new Date('2026-06-12T00:00:00Z'),
          agentWorkspace: { name: 'Support' },
        },
      ]);

      const res = await authedRequest(app).get('/agents/slack-channel-mappings');

      expect(res.status).toBe(200);
      expect(res.body.channels).toHaveLength(1);
      expect(res.body.channels[0].channelId).toBe('C03PSDNTYDT');
      // The query must be scoped only by slackChannelId — adding connectionId
      // is what hid legacy rows.
      expect(mockPrisma.slackMapping.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { slackChannelId: { not: null } } }),
      );
    });

    it('marks the flagged channel as main (else the oldest as the default)', async () => {
      mockPrisma.slackMapping.findMany.mockResolvedValue([
        {
          id: 'm-old',
          slackChannelId: 'C_OLD',
          slackChannelName: 'general',
          isMainChannel: false,
          createdAt: new Date('2026-06-01T00:00:00Z'),
          agentWorkspace: { name: 'A' },
        },
        {
          id: 'm-flagged',
          slackChannelId: 'C_FLAGGED',
          slackChannelName: 'alerts',
          isMainChannel: true,
          createdAt: new Date('2026-06-10T00:00:00Z'),
          agentWorkspace: { name: 'A' },
        },
      ]);

      const res = await authedRequest(app).get('/agents/slack-channel-mappings');

      expect(res.status).toBe(200);
      const byId = Object.fromEntries(res.body.channels.map((c: { id: string; isMain: boolean }) => [c.id, c.isMain]));
      expect(byId['m-flagged']).toBe(true);
      expect(byId['m-old']).toBe(false);
    });
  });

  describe('GET /slack-link-status', () => {
    it('reports DM + channel mappings without filtering by connectionId', async () => {
      // 1st findFirst = DM mapping (stored under a legacy UUID); 2nd = channel existence.
      mockPrisma.slackMapping.findFirst
        .mockResolvedValueOnce({ slackUserId: 'U123' })
        .mockResolvedValueOnce({ id: 'm-1' });

      const res = await authedRequest(app).get('/agents/slack-link-status');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        hasDmMapping: true,
        hasChannelMapping: true,
        slackUserId: 'U123',
      });
      expect(mockPrisma.slackMapping.findFirst).toHaveBeenNthCalledWith(1, {
        where: { slackUserId: { not: null } },
        select: { slackUserId: true },
      });
    });
  });

  describe('DELETE /slack/channel-mapping/:channelId', () => {
    it('unlinks by channelId alone (no connectionId scoping)', async () => {
      mockPrisma.slackMapping.deleteMany.mockResolvedValue({ count: 1 });

      const res = await authedRequest(app).delete(
        '/agents/slack/channel-mapping/C03PSDNTYDT',
      );

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(1);
      expect(mockPrisma.slackMapping.deleteMany).toHaveBeenCalledWith({
        where: { slackChannelId: 'C03PSDNTYDT' },
      });
    });
  });

  describe('PUT /slack/channel-mapping/:channelId/main', () => {
    it('sets the channel as the agent main channel', async () => {
      mockPrisma.slackMapping.findUnique.mockResolvedValue({ agentId: 'agent-1' });
      mockSlackMappingService.setMainChannel.mockResolvedValue(undefined);

      const res = await authedRequest(app).put('/agents/slack/channel-mapping/C123/main');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mockSlackMappingService.setMainChannel).toHaveBeenCalledWith('agent-1', 'C123');
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'slack main channel set',
        null,
        expect.objectContaining({ 'slack.channel.id': 'C123' }),
      );
    });

    it('returns 404 when the channel is not linked', async () => {
      mockPrisma.slackMapping.findUnique.mockResolvedValue(null);

      const res = await authedRequest(app).put('/agents/slack/channel-mapping/C_UNKNOWN/main');

      expect(res.status).toBe(404);
      expect(mockSlackMappingService.setMainChannel).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /slack/dm-mapping', () => {
    it('deletes the DM mapping without connectionId scoping', async () => {
      mockPrisma.slackMapping.deleteMany.mockResolvedValue({ count: 1 });

      const res = await authedRequest(app).delete('/agents/slack/dm-mapping');

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(1);
      expect(mockPrisma.slackMapping.deleteMany).toHaveBeenCalledWith({
        where: { slackUserId: { not: null } },
      });
    });
  });

  // ==========================================================================
  // POST /threads/get-or-create-by-external-id
  // ==========================================================================

  describe('POST /threads/get-or-create-by-external-id', () => {
    it('returns thread when all required fields provided', async () => {
      const mockThread = { id: 'thread-ext-1', agentId: 'agent-1', userId: 'user-1', externalThreadId: '1234.5678' };
      mockGetOrCreateThreadByExternalId.mockResolvedValue(mockThread);

      const res = await authedRequest(app)
        .post('/agents/threads/get-or-create-by-external-id')
        .send({ userId: 'user-1', agentId: 'agent-1', externalThreadId: '1234.5678', channelId: 'C123' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockThread);
      expect(mockGetOrCreateThreadByExternalId).toHaveBeenCalledWith(
        'user-1', 'agent-1', '1234.5678', { source: 'SLACK', channelId: 'C123' }
      );
    });

    it('omits channelId option when not provided', async () => {
      mockGetOrCreateThreadByExternalId.mockResolvedValue({ id: 'thread-ext-2' });

      await authedRequest(app)
        .post('/agents/threads/get-or-create-by-external-id')
        .send({ userId: 'user-1', agentId: 'agent-1', externalThreadId: '1234.5678' });

      expect(mockGetOrCreateThreadByExternalId).toHaveBeenCalledWith(
        'user-1', 'agent-1', '1234.5678', undefined
      );
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/threads/get-or-create-by-external-id')
        .send({ userId: 'user-1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('userId, agentId, externalThreadId');
    });

    it('returns 500 when service throws', async () => {
      mockGetOrCreateThreadByExternalId.mockRejectedValue(new Error('DB error'));

      const res = await authedRequest(app)
        .post('/agents/threads/get-or-create-by-external-id')
        .send({ userId: 'user-1', agentId: 'agent-1', externalThreadId: '1234.5678' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  // ==========================================================================
  // POST /slack/verify-link-code
  // ==========================================================================

  describe('POST /slack/verify-link-code', () => {
    it('returns 400 when code is missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/slack/verify-link-code')
        .send({ slackUserId: 'U123', dmChannelId: 'D456' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('code');
    });

    it('returns 400 when slackUserId is missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/slack/verify-link-code')
        .send({ code: 'AAAAAA', dmChannelId: 'D456' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('slackUserId');
    });

    it('returns 400 when dmChannelId is missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/slack/verify-link-code')
        .send({ code: 'AAAAAA', slackUserId: 'U123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('dmChannelId');
    });

    it('normalizes codes to uppercase', async () => {
      mockPrisma.slackVerificationCode.findUnique.mockResolvedValueOnce(null);

      await authedRequest(app)
        .post('/agents/slack/verify-link-code')
        .send({ code: 'abcdef', slackUserId: 'U123', dmChannelId: 'D456' });

      expect(mockPrisma.slackVerificationCode.findUnique).toHaveBeenCalledWith({
        where: { code_type: { code: 'ABCDEF', type: 'DM' } },
      });
    });

    it('returns failure for non-existent code', async () => {
      mockPrisma.slackVerificationCode.findUnique.mockResolvedValueOnce(null);

      const res = await authedRequest(app)
        .post('/agents/slack/verify-link-code')
        .send({ code: 'ZZZZZZ', slackUserId: 'U123', dmChannelId: 'D456' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('That code is not valid. Generate a new code in Prism Agent, under Settings → Channels.');
    });

    it('returns failure for expired code and deletes it', async () => {
      mockPrisma.slackVerificationCode.findUnique.mockResolvedValueOnce({
        id: 'vc-010',
        code: 'AAAAAA',
        type: 'DM',
        lensUserId: 'user-001',
        connectionId: 'conn-001',
        agentId: 'agent-001',
        expiresAt: new Date(Date.now() - 60 * 1000),
        createdAt: new Date(),
      });
      mockPrisma.slackVerificationCode.delete.mockResolvedValueOnce({});

      const res = await authedRequest(app)
        .post('/agents/slack/verify-link-code')
        .send({ code: 'AAAAAA', slackUserId: 'U123', dmChannelId: 'D456' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('That code has expired. Generate a new code in Prism Agent, under Settings → Channels.');
      expect(mockPrisma.slackVerificationCode.delete).toHaveBeenCalledWith({
        where: { code_type: { code: 'AAAAAA', type: 'DM' } },
      });
    });

    it('returns failure when Slack user is already linked to same agent (same lensUserId)', async () => {
      mockPrisma.slackVerificationCode.findUnique.mockResolvedValueOnce({
        id: 'vc-011',
        code: 'BBB222',
        type: 'DM',
        lensUserId: 'user-001',
        connectionId: 'conn-001',
        agentId: 'agent-001',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        createdAt: new Date(),
      });
      mockPrisma.slackMapping.findFirst.mockResolvedValueOnce({
        id: 'mapping-existing',
        connectionId: 'conn-001',
        slackUserId: 'U123',
        lensUserId: 'user-001',
        agentId: 'agent-001',
      });

      const res = await authedRequest(app)
        .post('/agents/slack/verify-link-code')
        .send({ code: 'BBB222', slackUserId: 'U123', dmChannelId: 'D456' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('already linked');
    });

    it('returns failure when Slack user is linked to a different Lens user', async () => {
      mockPrisma.slackVerificationCode.findUnique.mockResolvedValueOnce({
        id: 'vc-012',
        code: 'CCC333',
        type: 'DM',
        lensUserId: 'user-001',
        connectionId: 'conn-001',
        agentId: 'agent-001',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        createdAt: new Date(),
      });
      mockPrisma.slackMapping.findFirst.mockResolvedValueOnce({
        id: 'mapping-other',
        connectionId: 'conn-001',
        slackUserId: 'U123',
        lensUserId: 'user-999',
        agentId: 'agent-001',
      });

      const res = await authedRequest(app)
        .post('/agents/slack/verify-link-code')
        .send({ code: 'CCC333', slackUserId: 'U123', dmChannelId: 'D456' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('This Slack account is already linked to another Prism Agent user.');
    });

    it('atomically creates DM mapping and deletes code on success', async () => {
      mockPrisma.slackVerificationCode.findUnique.mockResolvedValueOnce({
        id: 'vc-013',
        code: 'DDD444',
        type: 'DM',
        lensUserId: 'user-001',
        connectionId: 'conn-001',
        agentId: 'agent-001',
        agentName: 'Test Agent',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        createdAt: new Date(),
      });
      mockPrisma.slackMapping.findFirst.mockResolvedValueOnce(null);
      mockPrisma.slackMapping.create.mockResolvedValueOnce({
        id: 'mapping-new',
        connectionId: 'conn-001',
        agentId: 'agent-001',
        slackUserId: 'U123',
        dmChannelId: 'D456',
        lensUserId: 'user-001',
      });
      mockPrisma.slackVerificationCode.delete.mockResolvedValueOnce({});

      const res = await authedRequest(app)
        .post('/agents/slack/verify-link-code')
        .send({ code: 'DDD444', slackUserId: 'U123', dmChannelId: 'D456' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Your Slack account is now linked. You can chat with Test Agent here.');
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.slackMapping.create).toHaveBeenCalledWith({
        data: {
          connectionId: 'conn-001',
          agentId: 'agent-001',
          slackUserId: 'U123',
          lensUserId: 'user-001',
          dmChannelId: 'D456',
        },
      });
    });
  });

  // ==========================================================================
  // POST /slack/create-verification-code
  // ==========================================================================

  describe('POST /slack/create-verification-code', () => {
    const validBody = {
      type: 'DM',
      lensUserId: 'user-001',
      connectionId: 'conn-001',
      agentId: 'agent-001',
      agentName: 'Test Agent',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };

    beforeEach(() => {
      mockPrisma.slackVerificationCode.deleteMany.mockResolvedValue({ count: 0 });
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/slack/create-verification-code')
        .send({ type: 'DM', lensUserId: 'user-001' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('creates a verification code on first attempt', async () => {
      mockPrisma.slackVerificationCode.create.mockResolvedValueOnce({
        id: 'vc-new',
        code: 'ABC123',
      });

      const res = await authedRequest(app)
        .post('/agents/slack/create-verification-code')
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.code).toBeDefined();
      expect(mockPrisma.slackVerificationCode.create).toHaveBeenCalledTimes(1);
    });

    it('retries on P2002 unique constraint collision and succeeds', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.slackVerificationCode.create
        .mockRejectedValueOnce(p2002)
        .mockRejectedValueOnce(p2002)
        .mockResolvedValueOnce({ id: 'vc-new', code: 'DEF456' });

      const res = await authedRequest(app)
        .post('/agents/slack/create-verification-code')
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.code).toBeDefined();
      expect(mockPrisma.slackVerificationCode.create).toHaveBeenCalledTimes(3);
    });

    it('returns 500 after exhausting all retry attempts', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.slackVerificationCode.create
        .mockRejectedValueOnce(p2002)
        .mockRejectedValueOnce(p2002)
        .mockRejectedValueOnce(p2002)
        .mockRejectedValueOnce(p2002)
        .mockRejectedValueOnce(p2002);

      const res = await authedRequest(app)
        .post('/agents/slack/create-verification-code')
        .send(validBody);

      expect(res.status).toBe(500);
      expect(mockPrisma.slackVerificationCode.create).toHaveBeenCalledTimes(5);
    });

    it('throws immediately on non-P2002 Prisma errors', async () => {
      mockPrisma.slackVerificationCode.create.mockRejectedValueOnce(
        new Error('Connection refused'),
      );

      const res = await authedRequest(app)
        .post('/agents/slack/create-verification-code')
        .send(validBody);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Connection refused');
      expect(mockPrisma.slackVerificationCode.create).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Route-level telemetry (handlers that own their prisma writes directly)
  // ==========================================================================

  describe('route telemetry', () => {
    // 'cron task scheduled' / 'cron task deleted' are owned by
    // cronSchedulerService (mocked here) — see cron-scheduler.service.test.ts.

    it('POST /slack/verify-link-code emits "slack dm linked" on success', async () => {
      mockPrisma.slackVerificationCode.findUnique.mockResolvedValueOnce({
        id: 'vc-1',
        code: 'AAAAAA',
        type: 'DM',
        lensUserId: 'user-001',
        connectionId: 'conn-001',
        agentId: 'agent-001',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        createdAt: new Date(),
      });
      mockPrisma.slackMapping.findFirst.mockResolvedValueOnce(null);
      mockPrisma.slackMapping.create.mockResolvedValueOnce({});
      mockPrisma.slackVerificationCode.delete.mockResolvedValueOnce({});

      const res = await authedRequest(app)
        .post('/agents/slack/verify-link-code')
        .send({ code: 'AAAAAA', slackUserId: 'U123', dmChannelId: 'D456' });

      expect(res.body.success).toBe(true);
      expect(mockTrackEvent).toHaveBeenCalledWith('slack dm linked', 'user-001', {
        'agent.id': 'agent-001',
        'slack.user.id': 'U123',
      });
    });

    it('POST /slack/verify-link-code emits nothing for an invalid code', async () => {
      mockPrisma.slackVerificationCode.findUnique.mockResolvedValueOnce(null);

      await authedRequest(app)
        .post('/agents/slack/verify-link-code')
        .send({ code: 'ZZZZZZ', slackUserId: 'U123', dmChannelId: 'D456' });

      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('POST /slack/verify-channel-link-code emits "slack channel linked" on success', async () => {
      mockPrisma.slackVerificationCode.findUnique.mockResolvedValueOnce({
        id: 'vc-2',
        code: 'BBBBBB',
        type: 'CHANNEL',
        lensUserId: 'user-001',
        connectionId: 'conn-001',
        agentId: 'agent-001',
        agentName: 'Agent',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        createdAt: new Date(),
      });
      mockPrisma.slackMapping.findUnique.mockResolvedValueOnce(null);
      mockPrisma.slackMapping.create.mockResolvedValueOnce({});
      mockPrisma.slackVerificationCode.delete.mockResolvedValueOnce({});

      const res = await authedRequest(app)
        .post('/agents/slack/verify-channel-link-code')
        .send({ code: 'BBBBBB', channelId: 'C123', channelName: '#general' });

      expect(res.body.success).toBe(true);
      expect(mockTrackEvent).toHaveBeenCalledWith('slack channel linked', 'user-001', {
        'agent.id': 'agent-001',
        'slack.channel.id': 'C123',
      });
    });

    it('POST /slack/create-verification-code emits "slack verification code created" without the code', async () => {
      mockPrisma.slackVerificationCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.slackVerificationCode.create.mockResolvedValueOnce({ id: 'vc-new' });

      const res = await authedRequest(app)
        .post('/agents/slack/create-verification-code')
        .send({
          type: 'DM',
          lensUserId: 'user-001',
          connectionId: 'conn-001',
          agentId: 'agent-001',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        });

      expect(mockTrackEvent).toHaveBeenCalledWith('slack verification code created', 'user-001', {
        'agent.id': 'agent-001',
        'verification.type': 'DM',
      });
      // The generated code must never appear in event attributes.
      const attrs = mockTrackEvent.mock.calls[0][2] as Record<string, string>;
      expect(Object.values(attrs)).not.toContain(res.body.code);
    });

    it('DELETE /slack/channel-mapping/:channelId emits "slack channel mapping deleted"', async () => {
      mockPrisma.slackMapping.deleteMany.mockResolvedValue({ count: 1 });

      await authedRequest(app).delete('/agents/slack/channel-mapping/C123');

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'slack channel mapping deleted',
        null,
        expect.objectContaining({ 'slack.channel.id': 'C123' }),
      );
    });

    it('DELETE /slack/dm-mapping emits "slack dm mapping deleted" with the count', async () => {
      mockPrisma.slackMapping.deleteMany.mockResolvedValue({ count: 2 });

      await authedRequest(app).delete('/agents/slack/dm-mapping?connectionId=conn-001');

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'slack dm mapping deleted',
        null,
        expect.objectContaining({ 'slack.mappings_removed': '2' }),
      );
    });

    it('DELETE /slack/dm-mapping emits nothing when no mappings were removed', async () => {
      mockPrisma.slackMapping.deleteMany.mockResolvedValue({ count: 0 });

      await authedRequest(app).delete('/agents/slack/dm-mapping?connectionId=conn-001');

      expect(mockTrackEvent).not.toHaveBeenCalled();
    });
  });

  describe('POST /slack/deliver', () => {
    it("hands the body's threadTs to the adapter as the channel thread", async () => {
      const deliver = vi.spyOn(slackAdapterService, 'deliver').mockResolvedValue(undefined);
      const message = { id: 'msg-1', threadId: 'thread-1', content: 'done' };

      const res = await authedRequest(app)
        .post('/agents/slack/deliver')
        .send({
          userId: 'user-1',
          message,
          channelContext: { channel: 'slack', channelId: 'C123', threadTs: '1700000000.000100', threadId: 'thread-1' },
        });

      expect(res.status).toBe(200);
      expect(deliver).toHaveBeenCalledWith('user-1', message, {
        channel: 'slack',
        channelId: 'C123',
        channelThreadId: '1700000000.000100',
        threadId: 'thread-1',
      });
    });
  });
});
