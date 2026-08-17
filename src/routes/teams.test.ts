import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const { mockPrisma, mockTeamsMappingService, mockGetTeamsConfig, mockTrackEvent } = vi.hoisted(() => ({
  mockPrisma: {
    teamsMapping: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    teamsVerificationCode: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  mockTeamsMappingService: { setMainChannel: vi.fn() },
  mockGetTeamsConfig: vi.fn(),
  mockTrackEvent: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock('../services/teams/teams-mapping.service', () => ({ teamsMappingService: mockTeamsMappingService }));
vi.mock('../lib/teams-config', () => ({ getTeamsConfig: mockGetTeamsConfig }));
vi.mock('../lib/telemetry', () => ({ trackEvent: mockTrackEvent }));
vi.mock('../config', () => ({ config: { agentId: 'agent-1' } }));

// eslint-disable-next-line import/first
import { teamsRouter } from './teams';

/** The teams routes carry no auth of their own; the header is harmless. */
function authedRequest(app: express.Express) {
  return {
    get: (url: string) => request(app).get(url),
    post: (url: string) => request(app).post(url),
    put: (url: string) => request(app).put(url),
    delete: (url: string) => request(app).delete(url),
  };
}

describe('teams routes', () => {
  const TEAMS_CONV_ID = '19:abc@thread.tacv2';
  const TEAMS_CONV_ID_ENCODED = encodeURIComponent(TEAMS_CONV_ID);
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/agents', teamsRouter);
  });

  describe('GET /teams/workspaces', () => {
    it('returns the configured connection', async () => {
      mockGetTeamsConfig.mockResolvedValue({
        id: 'tenant-1',
        tenantId: 'tenant-1',
        clientId: 'app-1',
        name: 'Microsoft Teams',
      });

      const res = await authedRequest(app).get('/agents/teams/workspaces');

      expect(res.status).toBe(200);
      expect(res.body.workspaces).toEqual([
        { tenantId: 'tenant-1', clientId: 'app-1', name: 'Microsoft Teams' },
      ]);
    });

    it('returns an empty list when Teams is not configured', async () => {
      mockGetTeamsConfig.mockResolvedValue(null);

      const res = await authedRequest(app).get('/agents/teams/workspaces');

      expect(res.status).toBe(200);
      expect(res.body.workspaces).toEqual([]);
    });
  });

  describe('GET /teams-link-status', () => {
    it('reports DM + channel mappings', async () => {
      mockPrisma.teamsMapping.findFirst
        .mockResolvedValueOnce({ teamsUserId: 'aad-1' })
        .mockResolvedValueOnce({ id: 'm-1' });

      const res = await authedRequest(app).get('/agents/teams-link-status');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        hasDmMapping: true,
        hasChannelMapping: true,
        teamsUserId: 'aad-1',
      });
    });
  });

  describe('GET /teams-channel-mappings', () => {
    it('marks the flagged channel as main (else the oldest as the default)', async () => {
      mockPrisma.teamsMapping.findMany.mockResolvedValue([
        {
          id: 'm-old',
          channelConversationId: '19:old@thread.tacv2',
          channelName: 'general',
          isMainChannel: false,
          createdAt: new Date('2026-06-01T00:00:00Z'),
          agentWorkspace: { name: 'A' },
        },
        {
          id: 'm-flagged',
          channelConversationId: TEAMS_CONV_ID,
          channelName: 'alerts',
          isMainChannel: true,
          createdAt: new Date('2026-06-10T00:00:00Z'),
          agentWorkspace: { name: 'A' },
        },
      ]);

      const res = await authedRequest(app).get('/agents/teams-channel-mappings');

      expect(res.status).toBe(200);
      const byId = Object.fromEntries(
        res.body.channels.map((c: { id: string; isMain: boolean }) => [c.id, c.isMain]),
      );
      expect(byId['m-flagged']).toBe(true);
      expect(byId['m-old']).toBe(false);
      expect(res.body.channels[1].conversationId).toBe(TEAMS_CONV_ID);
    });
  });

  describe('POST /teams/create-verification-code', () => {
    it('creates a 6-hex code and emits telemetry without the code', async () => {
      mockPrisma.teamsVerificationCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.teamsVerificationCode.create.mockResolvedValue({});

      const res = await authedRequest(app)
        .post('/agents/teams/create-verification-code')
        .send({
          type: 'DM',
          lensUserId: 'user-1',
          connectionId: 'tenant-1',
          agentId: 'agent-1',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        });

      expect(res.status).toBe(200);
      expect(res.body.code).toMatch(/^[A-F0-9]{6}$/);
      expect(mockTrackEvent).toHaveBeenCalledWith('teams verification code created', 'user-1', {
        'agent.id': 'agent-1',
        'verification.type': 'DM',
      });
    });

    it('rejects a request with missing fields', async () => {
      mockPrisma.teamsVerificationCode.deleteMany.mockResolvedValue({ count: 0 });

      const res = await authedRequest(app)
        .post('/agents/teams/create-verification-code')
        .send({ type: 'DM' });

      expect(res.status).toBe(400);
      expect(mockPrisma.teamsVerificationCode.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown type with 400 (not a Prisma 500)', async () => {
      mockPrisma.teamsVerificationCode.deleteMany.mockResolvedValue({ count: 0 });

      const res = await authedRequest(app)
        .post('/agents/teams/create-verification-code')
        .send({
          type: 'BOGUS',
          lensUserId: 'user-1',
          connectionId: 'tenant-1',
          agentId: 'agent-1',
          expiresAt: new Date().toISOString(),
        });

      expect(res.status).toBe(400);
      expect(mockPrisma.teamsVerificationCode.create).not.toHaveBeenCalled();
    });

    it('rejects an unparseable expiresAt with 400', async () => {
      mockPrisma.teamsVerificationCode.deleteMany.mockResolvedValue({ count: 0 });

      const res = await authedRequest(app)
        .post('/agents/teams/create-verification-code')
        .send({
          type: 'DM',
          lensUserId: 'user-1',
          connectionId: 'tenant-1',
          agentId: 'agent-1',
          expiresAt: 'garbage',
        });

      expect(res.status).toBe(400);
      expect(mockPrisma.teamsVerificationCode.create).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /teams/dm-mapping', () => {
    it('deletes the DM mapping rows', async () => {
      mockPrisma.teamsMapping.deleteMany.mockResolvedValue({ count: 1 });

      const res = await authedRequest(app).delete('/agents/teams/dm-mapping');

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(1);
      expect(mockPrisma.teamsMapping.deleteMany).toHaveBeenCalledWith({
        where: { teamsUserId: { not: null } },
      });
    });
  });

  describe('DELETE /teams/channel-mapping/:conversationId', () => {
    it('unlinks by the URI-encoded conversation id', async () => {
      mockPrisma.teamsMapping.deleteMany.mockResolvedValue({ count: 1 });

      const res = await authedRequest(app).delete(
        `/agents/teams/channel-mapping/${TEAMS_CONV_ID_ENCODED}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(1);
      expect(mockPrisma.teamsMapping.deleteMany).toHaveBeenCalledWith({
        where: { channelConversationId: TEAMS_CONV_ID },
      });
    });

    it('returns 404 when nothing matches', async () => {
      mockPrisma.teamsMapping.deleteMany.mockResolvedValue({ count: 0 });

      const res = await authedRequest(app).delete(
        `/agents/teams/channel-mapping/${TEAMS_CONV_ID_ENCODED}`,
      );

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /teams/channel-mapping/:conversationId/main', () => {
    it('sets the channel as the agent main channel', async () => {
      mockPrisma.teamsMapping.findUnique.mockResolvedValue({ agentId: 'agent-1' });
      mockTeamsMappingService.setMainChannel.mockResolvedValue(undefined);

      const res = await authedRequest(app).put(
        `/agents/teams/channel-mapping/${TEAMS_CONV_ID_ENCODED}/main`,
      );

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mockTeamsMappingService.setMainChannel).toHaveBeenCalledWith(
        'agent-1',
        TEAMS_CONV_ID,
      );
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'teams main channel set',
        null,
        expect.objectContaining({ 'teams.conversation.id': TEAMS_CONV_ID }),
      );
    });

    it('returns 404 when the channel is not linked', async () => {
      mockPrisma.teamsMapping.findUnique.mockResolvedValue(null);

      const res = await authedRequest(app).put(
        `/agents/teams/channel-mapping/${TEAMS_CONV_ID_ENCODED}/main`,
      );

      expect(res.status).toBe(404);
      expect(mockTeamsMappingService.setMainChannel).not.toHaveBeenCalled();
    });
  });
});
