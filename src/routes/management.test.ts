/**
 * Management Routes Tests
 *
 * Tests for all route handlers: heartbeat start/stop/trigger/status,
 * auth validation, and error responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockStartHeartbeat,
  mockStopHeartbeat,
  mockTriggerHeartbeat,
  mockGetStatus,
  mockGetAgent,
  mockGetThread,
  mockListThreads,
  mockAddMessage,
  mockGetOrCreateLatestThread,
  mockGetOrCreateFreshThread,
  mockFindLatestWebThread,
  mockGetOwnedThreadId,
  mockGetThreadWorkspaceRoot,
  mockSetExternalId,
  mockGetOrCreateThreadByExternalId,
  mockGetCatalog,
  mockFind,
  mockChatEngine,
  mockPrisma,
  mockSlackHeartbeatTriggerService,
  mockSlackMappingService,
} = vi.hoisted(() => ({
  mockStartHeartbeat: vi.fn(),
  mockStopHeartbeat: vi.fn(),
  mockTriggerHeartbeat: vi.fn(),
  mockGetStatus: vi.fn(),
  mockGetAgent: vi.fn(),
  mockGetThread: vi.fn(),
  mockListThreads: vi.fn(),
  mockAddMessage: vi.fn(),
  mockGetOrCreateLatestThread: vi.fn(),
  mockGetOrCreateFreshThread: vi.fn(),
  mockFindLatestWebThread: vi.fn(),
  mockGetOwnedThreadId: vi.fn(),
  mockGetThreadWorkspaceRoot: vi.fn(),
  mockSetExternalId: vi.fn(),
  mockGetOrCreateThreadByExternalId: vi.fn(),
  mockGetCatalog: vi.fn(),
  mockFind: vi.fn(),
  mockChatEngine: vi.fn(),
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
    listChannelIds: vi.fn(),
  },
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
    webhookSubscription: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    agentWorkspace: {
      update: vi.fn(),
    },
  },
}));

const { mockSetReceiverEnabled } = vi.hoisted(() => ({ mockSetReceiverEnabled: vi.fn() }));

vi.mock('../services/webhook-receiver.service', () => ({
  webhookReceiverService: { enabled: false, setEnabled: mockSetReceiverEnabled },
}));

vi.mock('../services/heartbeat.service', () => ({
  heartbeatService: {
    startHeartbeat: mockStartHeartbeat,
    stopHeartbeat: mockStopHeartbeat,
    triggerHeartbeat: mockTriggerHeartbeat,
    getStatus: mockGetStatus,
  },
}));

vi.mock('../services/agent-workspace.service', async () => {
  const actual = await vi.importActual<typeof import('../services/agent-workspace.service')>(
    '../services/agent-workspace.service',
  );
  // Keep the real instance (so `renameAgent` and other prototype methods stay
  // available) but redirect `getAgent` to the controllable mock.
  (actual.agentWorkspaceService as unknown as { getAgent: typeof mockGetAgent }).getAgent =
    mockGetAgent;
  return actual;
});

vi.mock('../services/conversation.service', () => ({
  conversationService: {
    getThread: mockGetThread,
    listThreads: mockListThreads,
    addMessage: mockAddMessage,
    getOrCreateLatestThread: mockGetOrCreateLatestThread,
    getOrCreateFreshThread: mockGetOrCreateFreshThread,
    findLatestWebThread: mockFindLatestWebThread,
    getOwnedThreadId: mockGetOwnedThreadId,
    getThreadWorkspaceRoot: mockGetThreadWorkspaceRoot,
    setExternalId: mockSetExternalId,
    getOrCreateThreadByExternalId: mockGetOrCreateThreadByExternalId,
  },
}));

const { mockHasCompactableHistory, mockCompactNow } = vi.hoisted(() => ({
  mockHasCompactableHistory: vi.fn(),
  mockCompactNow: vi.fn(),
}));

// Mocked for route control AND because the WS gateway (pulled in via
// createApp) subscribes to `compactionService.events` in its constructor.
vi.mock('../services/compaction.service', () => ({
  compactionService: {
    hasCompactableHistory: mockHasCompactableHistory,
    compactNow: mockCompactNow,
    maybeAutoCompact: vi.fn(),
    events: { on: vi.fn(), off: vi.fn() },
  },
}));

vi.mock('../services/skill-catalog.service', () => ({
  skillCatalogService: { getCatalog: mockGetCatalog, find: mockFind },
}));

vi.mock('../services/conversation-engine.service', () => ({
  conversationEngineService: { chat: mockChatEngine },
}));

vi.mock('../services/slack-heartbeat-trigger.service', () => ({
  slackHeartbeatTriggerService: mockSlackHeartbeatTriggerService,
}));

vi.mock('../services/slack-mapping.service', () => ({
  slackMappingService: mockSlackMappingService,
}));

const { mockTeamsMappingService, mockGetTeamsConfig } = vi.hoisted(() => ({
  mockTeamsMappingService: {
    setMainChannel: vi.fn(),
    getMainChannel: vi.fn(),
  },
  mockGetTeamsConfig: vi.fn(),
}));

vi.mock('../services/teams/teams-mapping.service', () => ({
  teamsMappingService: mockTeamsMappingService,
}));

vi.mock('../lib/teams-config', () => ({
  getTeamsConfig: mockGetTeamsConfig,
}));

const { mockExportAgent, mockImportAgent } = vi.hoisted(() => ({
  mockExportAgent: vi.fn(),
  mockImportAgent: vi.fn(),
}));

const { mockAttachmentCreate, mockAttachmentGetById, mockAttachmentLoadBytes, mockAttachmentDeleteUnlinked } = vi.hoisted(() => ({
  mockAttachmentCreate: vi.fn(),
  mockAttachmentGetById: vi.fn(),
  mockAttachmentLoadBytes: vi.fn(),
  mockAttachmentDeleteUnlinked: vi.fn(),
}));

// Keep the real detection/classification helpers; only stub the DB-backed
// service instance (the test's prisma mock has no messageAttachment delegate).
vi.mock('../services/attachment.service', async () => {
  const actual = await vi.importActual<typeof import('../services/attachment.service')>(
    '../services/attachment.service',
  );
  return {
    ...actual,
    attachmentService: {
      ...actual.attachmentService,
      create: mockAttachmentCreate,
      getById: mockAttachmentGetById,
      loadBytes: mockAttachmentLoadBytes,
      deleteUnlinked: mockAttachmentDeleteUnlinked,
    },
  };
});

vi.mock('../services/agent-archive.service', async () => {
  const actual = await vi.importActual<typeof import('../services/agent-archive.service')>(
    '../services/agent-archive.service',
  );
  return {
    ...actual,
    exportAgent: mockExportAgent,
    importAgent: mockImportAgent,
  };
});


vi.mock('../lib/prisma', () => ({
  prisma: mockPrisma,
}));

// Must mock invoke so the createApp import chain does not pull in real dependencies
vi.mock('../invoke', () => ({
  invoke: vi.fn(),
}));

const { mockTrackEvent } = vi.hoisted(() => ({ mockTrackEvent: vi.fn() }));

vi.mock('../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
  isTelemetryEnabled: () => false,
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { createApp } from '../server';
import { config } from '../config';
import { allowing, boundTo } from '../test-utils/origin-config';
import { messageDeliveryService } from '../services/message-delivery.service';
import { slackAdapterService } from '../services/slack-adapter.service';

// As index.ts registers it: the webhook routes check Slack's linked channels through it.
messageDeliveryService.register(slackAdapterService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authedRequest(app: ReturnType<typeof createApp>) {
  return {
    post: (url: string) =>
      request(app).post(url).set('Authorization', 'Bearer test-secret'),
    get: (url: string) =>
      request(app).get(url).set('Authorization', 'Bearer test-secret'),
    patch: (url: string) =>
      request(app).patch(url).set('Authorization', 'Bearer test-secret'),
    put: (url: string) =>
      request(app).put(url).set('Authorization', 'Bearer test-secret'),
    delete: (url: string) =>
      request(app).delete(url).set('Authorization', 'Bearer test-secret'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Management Routes', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  // ==========================================================================
  // Origin guard (mounted app-wide, ahead of every route)
  // ==========================================================================

  describe('origin guard', () => {
    it('refuses a request from a foreign origin before it reaches the handler', async () => {
      const res = await authedRequest(app)
        .post('/agents/heartbeat/trigger')
        .set('Origin', 'https://evil.example')
        .send({ agentId: 'agent-1' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Forbidden origin');
      expect(mockTriggerHeartbeat).not.toHaveBeenCalled();
    });

    it('serves a request from the origin it is hosted on', async () => {
      mockTriggerHeartbeat.mockResolvedValue({ action: 'ok', message: 'All clear' });

      const res = await request(app)
        .post('/agents/heartbeat/trigger')
        .set('Host', 'localhost:3003')
        .set('Origin', 'http://localhost:3003')
        .send({ agentId: 'agent-1' });

      expect(res.status).toBe(200);
      expect(mockTriggerHeartbeat).toHaveBeenCalled();
    });

    describe('for an origin PRISM_ALLOWED_ORIGINS lists', () => {
      const ORIGIN = 'https://app.example.com';

      // The production shape: the list is set only on a widened bind.
      beforeEach(() => {
        boundTo('0.0.0.0');
        allowing(ORIGIN);
      });

      afterEach(() => {
        boundTo('127.0.0.1');
        allowing('');
      });

      const expectCors = (res: { headers: Record<string, string | undefined> }) => {
        expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
        expect(res.headers.vary).toContain('Origin');
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      };

      it('names the origin on an attachment download', async () => {
        mockAttachmentGetById.mockResolvedValue({
          id: 'att-1',
          filename: 'pic.png',
          mediaType: 'image/png',
          storagePath: 'att-1-pic.png',
        });
        mockAttachmentLoadBytes.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

        const res = await authedRequest(app).get('/agents/attachments/att-1').set('Origin', ORIGIN);

        expect(res.status).toBe(200);
        expectCors(res);
      });

      it('names the origin on a rejected attachment upload', async () => {
        const res = await authedRequest(app)
          .post('/agents/attachments')
          .set('Origin', ORIGIN)
          .attach('not-file', Buffer.from('hello'), 'notes.txt');

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Upload rejected');
        expectCors(res);
        expect(mockAttachmentCreate).not.toHaveBeenCalled();
      });

      it('names the origin on an error the body parser raises', async () => {
        const res = await authedRequest(app)
          .post('/agents/heartbeat/trigger')
          .set('Origin', ORIGIN)
          .set('Content-Type', 'application/json')
          .send('{');

        expect(res.status).toBe(400);
        expectCors(res);
        expect(mockTriggerHeartbeat).not.toHaveBeenCalled();
      });

      it('names the origin on a route that does not exist', async () => {
        const res = await authedRequest(app).get('/agents/no-such-route').set('Origin', ORIGIN);

        expect(res.status).toBe(404);
        expectCors(res);
      });
    });
  });

  // ==========================================================================
  // POST /chat
  // ==========================================================================

  describe('POST /chat', () => {
    it('lets the turn run to completion while the client stays connected', async () => {
      // The body parser drains `req` before the handler runs, so a disconnect
      // listener on the request side fires immediately and cancels every turn.
      // Read the signal from inside the turn, after a tick, to catch that.
      let abortedDuringTurn: boolean | null = null;
      mockChatEngine.mockImplementation(
        async ({ abortSignal }: { abortSignal: AbortSignal }) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          abortedDuringTurn = abortSignal.aborted;
          return {
            threadId: 'thread-1',
            content: 'answer',
            toolCalls: [],
            durationMs: 20,
            titleSet: null,
          };
        },
      );

      const res = await authedRequest(app)
        .post('/agents/chat')
        .send({ userId: 'user-1', agentId: 'agent-1', message: 'hello' });

      expect(res.status).toBe(200);
      expect(abortedDuringTurn).toBe(false);
      expect(res.body.content).toBe('answer');
    });
  });

  // ==========================================================================
  // POST /heartbeat/start
  // ==========================================================================

  describe('POST /heartbeat/start', () => {
    it('starts from the persisted row and forces heartbeatStatus to ENABLED', async () => {
      const lastHeartbeat = new Date('2025-01-15T04:00:00Z');
      const persisted = {
        id: 'agent-1',
        userId: 'user-1',
        heartbeatIntervalMs: 60000,
        heartbeatStatus: 'STOPPED',
        lastHeartbeat,
      };
      mockGetAgent.mockResolvedValue(persisted);

      const res = await authedRequest(app)
        .post('/agents/heartbeat/start')
        .send({
          // A client sends JSON, so its `lastHeartbeat` is a string, and it can
          // be stale. The schedule comes off the persisted row instead.
          agent: { id: 'agent-1', userId: 'user-1', lastHeartbeat: '2025-01-01T00:00:00Z' },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Heartbeat started');
      // The /start endpoint's whole purpose is to turn the heartbeat on,
      // regardless of the persisted heartbeatStatus.
      expect(mockStartHeartbeat).toHaveBeenCalledWith(
        { ...persisted, heartbeatStatus: 'ENABLED' },
        'keep-schedule',
      );
    });

    it('returns 400 when agent is missing from body', async () => {
      const res = await authedRequest(app)
        .post('/agents/heartbeat/start')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Missing agent in request body');
      expect(mockStartHeartbeat).not.toHaveBeenCalled();
    });

    it('returns 500 when startHeartbeat throws', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1' });
      mockStartHeartbeat.mockImplementation(() => {
        throw new Error('Invalid agent');
      });

      const res = await authedRequest(app)
        .post('/agents/heartbeat/start')
        .send({ agent: { id: 'agent-1', userId: 'user-1' } });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Invalid agent');
    });
  });

  // ==========================================================================
  // POST /heartbeat/stop
  // ==========================================================================

  describe('POST /heartbeat/stop', () => {
    it('stops heartbeat and returns success', async () => {
      const res = await authedRequest(app)
        .post('/agents/heartbeat/stop')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockStopHeartbeat).toHaveBeenCalledWith();
    });

    it('returns 500 when stopHeartbeat throws', async () => {
      mockStopHeartbeat.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const res = await authedRequest(app)
        .post('/agents/heartbeat/stop')
        .send();

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Unexpected error');
    });
  });

  // ==========================================================================
  // POST /heartbeat/trigger
  // ==========================================================================

  describe('POST /heartbeat/trigger', () => {
    it('triggers heartbeat and returns the result', async () => {
      mockTriggerHeartbeat.mockResolvedValue({ action: 'ok', message: 'All clear' });

      const res = await authedRequest(app)
        .post('/agents/heartbeat/trigger')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.result).toEqual({ action: 'ok', message: 'All clear' });
      expect(mockTriggerHeartbeat).toHaveBeenCalledWith();
    });

    it('returns 500 when triggerHeartbeat rejects', async () => {
      mockTriggerHeartbeat.mockRejectedValue(new Error('Heartbeat error'));

      const res = await authedRequest(app)
        .post('/agents/heartbeat/trigger')
        .send();

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Heartbeat error');
    });
  });

  // ==========================================================================
  // GET /heartbeat/status
  // ==========================================================================

  describe('GET /heartbeat/status', () => {
    it('returns heartbeat status when active', async () => {
      mockGetStatus.mockReturnValue({
        isActive: true,
        lastRun: '2025-01-15T12:00:00Z',
        isRunning: false,
        consecutiveErrors: 0,
      });

      const res = await authedRequest(app)
        .get('/agents/heartbeat/status');

      expect(res.status).toBe(200);
      expect(res.body.isActive).toBe(true);
      expect(res.body.lastRun).toBe('2025-01-15T12:00:00Z');
    });

    it('returns default inactive status when agent has no heartbeat', async () => {
      mockGetStatus.mockReturnValue(null);

      const res = await authedRequest(app)
        .get('/agents/heartbeat/status');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        isActive: false,
        lastRun: null,
        isRunning: false,
        consecutiveErrors: 0,
      });
    });

    it('returns 500 when getStatus throws', async () => {
      mockGetStatus.mockImplementation(() => {
        throw new Error('Status error');
      });

      const res = await authedRequest(app)
        .get('/agents/heartbeat/status');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Status error');
    });
  });

  // ==========================================================================
  // PATCH /heartbeat/interval
  // ==========================================================================

  describe('PATCH /heartbeat/interval', () => {
    it('updates the interval, restarts the timer, and returns the new status', async () => {
      mockGetAgent.mockResolvedValue({
        id: 'agent-1',
        userId: 'user-1',
        heartbeatIntervalMs: 480 * 60_000,
      });
      const updated = { id: 'agent-1', userId: 'user-1', heartbeatIntervalMs: 5 * 60_000 };
      mockPrisma.agentWorkspace.update.mockResolvedValue(updated);
      mockGetStatus.mockReturnValue({
        isActive: true,
        lastRun: null,
        isRunning: false,
        consecutiveErrors: 0,
        intervalMs: 5 * 60_000,
      });

      const res = await authedRequest(app)
        .patch('/agents/heartbeat/interval')
        .send({ intervalMs: 5 * 60_000 });

      expect(res.status).toBe(200);
      expect(res.body.intervalMs).toBe(5 * 60_000);
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: { heartbeatIntervalMs: 5 * 60_000 },
      });
      // A new cadence starts from now, so the next check is one new interval away.
      expect(mockStartHeartbeat).toHaveBeenCalledWith(updated, 'new-interval');
      // Must NOT call stopHeartbeat — that would race the fire-and-forget
      // status write and could leave the agent persisted as STOPPED.
      expect(mockStopHeartbeat).not.toHaveBeenCalled();
    });

    it('returns 400 when intervalMs is missing or not a number', async () => {
      const res = await authedRequest(app)
        .patch('/agents/heartbeat/interval')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('finite number');
    });

    it('returns 400 when intervalMs is below the 1-minute floor', async () => {
      const res = await authedRequest(app)
        .patch('/agents/heartbeat/interval')
        .send({ intervalMs: 1000 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('1 minute');
    });

    it('returns 400 when intervalMs exceeds the 1-week ceiling', async () => {
      const res = await authedRequest(app)
        .patch('/agents/heartbeat/interval')
        .send({ intervalMs: 7 * 24 * 60 * 60_000 + 1 });
      expect(res.status).toBe(400);
    });

    it('returns 500 when the agent is missing', async () => {
      mockGetAgent.mockRejectedValue(new Error('Agent not found'));
      const res = await authedRequest(app)
        .patch('/agents/heartbeat/interval')
        .send({ intervalMs: 5 * 60_000 });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Agent not found');
    });

    it('returns 500 when Prisma update throws', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1' });
      mockPrisma.agentWorkspace.update.mockRejectedValue(new Error('DB error'));
      const res = await authedRequest(app)
        .patch('/agents/heartbeat/interval')
        .send({ intervalMs: 5 * 60_000 });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  // ==========================================================================
  // PATCH /name
  // ==========================================================================

  describe('PATCH /name', () => {
    it('renames the agent and returns the updated identity', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', name: 'Old' });
      mockPrisma.agentWorkspace.update.mockResolvedValue({
        id: 'agent-1',
        userId: 'user-1',
        name: 'NewName',
      });

      const res = await authedRequest(app)
        .patch('/agents/name')
        .send({ name: '  NewName  ' }); // whitespace trimmed

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ agentId: 'agent-1', userId: 'user-1', name: 'NewName' });
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: { name: 'NewName' },
      });
    });

    it('returns 400 when name is missing', async () => {
      const res = await authedRequest(app)
        .patch('/agents/name')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('non-empty');
    });

    it('returns 400 when name is empty / only whitespace', async () => {
      const res = await authedRequest(app)
        .patch('/agents/name')
        .send({ name: '   ' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when name exceeds 64 chars', async () => {
      const res = await authedRequest(app)
        .patch('/agents/name')
        .send({ name: 'a'.repeat(65) });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('64');
    });

    it('returns 500 when the agent is missing', async () => {
      mockGetAgent.mockRejectedValue(new Error('Agent not found'));
      const res = await authedRequest(app)
        .patch('/agents/name')
        .send({ name: 'NewName' });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Agent not found');
    });

    it('returns 500 when Prisma update throws', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', name: 'Old' });
      mockPrisma.agentWorkspace.update.mockRejectedValue(new Error('DB error'));
      const res = await authedRequest(app)
        .patch('/agents/name')
        .send({ name: 'NewName' });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  // ==========================================================================
  // POST /goals
  // ==========================================================================

  describe('POST /goals validation', () => {
    it('returns 400 when threadId or objective is missing', async () => {
      const res = await authedRequest(app).post('/agents/goals').send({ objective: 'do it' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('returns 400 for a non-positive-integer tokenBudget', async () => {
      for (const tokenBudget of [-5, 0, 3.5]) {
        const res = await authedRequest(app)
          .post('/agents/goals')
          .send({ threadId: 't-1', objective: 'do it', tokenBudget });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('tokenBudget');
      }
    });
  });

  // ==========================================================================
  // Webhook Management
  // ==========================================================================

  describe('GET + PATCH /webhooks/receiver', () => {
    it('returns the receiver enabled state', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', webhooksEnabled: false });

      const res = await authedRequest(app).get('/agents/webhooks/receiver');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ enabled: false, port: 3004, publicUrl: null });
    });

    it('returns the actual listener state after applying the toggle', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', webhooksEnabled: false });
      mockPrisma.agentWorkspace.update.mockResolvedValue({});

      const res = await authedRequest(app)
        .patch('/agents/webhooks/receiver')
        .send({ enabled: true });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ enabled: false });
      expect(mockSetReceiverEnabled).toHaveBeenCalledWith(true);
    });

    it('reports a listener failure to the caller', async () => {
      mockSetReceiverEnabled.mockRejectedValue(new Error('Webhook port is already in use'));
      const res = await authedRequest(app)
        .patch('/agents/webhooks/receiver')
        .send({ enabled: true });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Webhook port is already in use');
    });

    it('rejects a non-boolean enabled', async () => {
      const res = await authedRequest(app)
        .patch('/agents/webhooks/receiver')
        .send({ enabled: 'yes' });

      expect(res.status).toBe(400);
      expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /webhook-subscriptions', () => {
    beforeEach(() => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1' });
    });

    it('creates a subscription with a normalized name', async () => {
      const created = { id: 'wh-1', name: 'github-push', deliverTo: 'all', deliverOnly: false };
      mockPrisma.webhookSubscription.create.mockResolvedValue(created);

      const res = await authedRequest(app)
        .post('/agents/webhook-subscriptions')
        .send({ name: '  GitHub Push ', description: 'PR events', authType: 'none' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ...created, slackChannelIds: [], hasSecret: false });
      expect(mockPrisma.webhookSubscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          agentId: 'agent-1',
          name: 'github-push',
          description: 'PR events',
          deliverTo: 'all',
          deliverOnly: false,
          // None is an explicit choice.
          authType: 'none',
          secret: null,
        }),
      });
    });

    it('stores the chosen Slack channels when each is linked to the agent', async () => {
      mockSlackMappingService.listChannelIds.mockResolvedValueOnce(['C_MAIN', 'C_REL', 'C_IOS']);
      mockPrisma.webhookSubscription.create.mockResolvedValue({
        id: 'wh-1',
        deliverTo: 'slack',
        slackChannelIds: 'C_REL,C_IOS',
      });

      const res = await authedRequest(app).post('/agents/webhook-subscriptions').send({
        name: 'release-notes',
        deliverTo: 'slack',
        slackChannelIds: [' C_REL', 'C_REL', 'C_IOS'],
        authType: 'none',
      });

      expect(res.status).toBe(201);
      expect(res.body.slackChannelIds).toEqual(['C_REL', 'C_IOS']);
      expect(mockSlackMappingService.listChannelIds).toHaveBeenCalledWith('agent-1');
      expect(mockPrisma.webhookSubscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ deliverTo: 'slack', slackChannelIds: 'C_REL,C_IOS' }),
      });
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'webhook subscription created',
        'user-1',
        expect.objectContaining({ 'webhook.slack_channels': '2' }),
      );
    });

    it.each([
      { case: 'a channel not linked to the agent', deliverTo: 'slack', slackChannelIds: ['C_OTHER'] },
      { case: 'a list for another target', deliverTo: 'all', slackChannelIds: ['C_REL'] },
      { case: 'a list that is not an array of ids', deliverTo: 'slack', slackChannelIds: 'C_REL' },
    ])('rejects $case', async ({ deliverTo, slackChannelIds }) => {
      mockSlackMappingService.listChannelIds.mockResolvedValueOnce(['C_REL']);

      const res = await authedRequest(app).post('/agents/webhook-subscriptions').send({
        name: 'release-notes',
        deliverTo,
        slackChannelIds,
        authType: 'none',
      });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.slackChannelIds).toBeTruthy();
      expect(mockPrisma.webhookSubscription.create).not.toHaveBeenCalled();
    });

    it('requires credentials by default and stores token authentication when supplied', async () => {
      const missing = await authedRequest(app).post('/agents/webhook-subscriptions')
        .send({ name: 'default-auth' });
      expect(missing.status).toBe(400);
      expect(missing.body.fieldErrors.secret).toBeTruthy();
      expect(mockPrisma.webhookSubscription.create).not.toHaveBeenCalled();
      mockPrisma.webhookSubscription.create.mockResolvedValue({ id: 'wh-1', secret: 'demo-token' });
      const created = await authedRequest(app).post('/agents/webhook-subscriptions')
        .send({ name: 'default-auth', authHeader: 'Authorization', secret: 'demo-token' });
      expect(created.status).toBe(201);
      expect(mockPrisma.webhookSubscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ authType: 'token', authHeader: 'Authorization', secret: 'demo-token' }),
      });
    });

    it('stores the generic auth configuration', async () => {
      mockPrisma.webhookSubscription.create.mockResolvedValue({
        id: 'wh-1',
        name: 'alerts',
        authType: 'hmac',
        secret: 'shhh',
      });

      const res = await authedRequest(app).post('/agents/webhook-subscriptions').send({
        name: 'alerts',
        authType: 'hmac',
        authHeader: '  X-Hub-Signature-256 ',
        authPrefix: 'sha256=',
        authAlgorithm: 'sha512',
        authEncoding: 'base64',
        secret: '  shhh  ',
      });

      expect(res.status).toBe(201);
      expect(mockPrisma.webhookSubscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          authType: 'hmac',
          authHeader: 'X-Hub-Signature-256',
          authPrefix: 'sha256=',
          authAlgorithm: 'sha512',
          authEncoding: 'base64',
          secret: 'shhh',
        }),
      });
      // The stored secret never travels back out.
      expect(res.body).not.toHaveProperty('secret');
      expect(res.body.hasSecret).toBe(true);
    });

    describe('signed URL', () => {
      const hmacBody = {
        name: 'boards',
        authType: 'hmac',
        authHeader: 'X-Signature',
        authAlgorithm: 'sha1',
        authEncoding: 'base64',
        secret: 'shhh',
      };

      it('stores a trimmed http(s) URL for an HMAC scheme', async () => {
        mockPrisma.webhookSubscription.create.mockResolvedValue({ id: 'wh-1', name: 'boards' });

        const res = await authedRequest(app).post('/agents/webhook-subscriptions')
          .send({ ...hmacBody, authSignedUrl: ' https://prism.example.com/agents/webhooks/boards ' });

        expect(res.status).toBe(201);
        expect(mockPrisma.webhookSubscription.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            authSignedUrl: 'https://prism.example.com/agents/webhooks/boards',
          }),
        });
      });

      it('rejects a value that is not an absolute http(s) URL', async () => {
        for (const authSignedUrl of ['/agents/webhooks/boards', 'ftp://prism.example.com/x', 'not a url']) {
          const res = await authedRequest(app).post('/agents/webhook-subscriptions')
            .send({ ...hmacBody, authSignedUrl });
          expect(res.status).toBe(400);
          expect(res.body.fieldErrors.authSignedUrl).toBeTruthy();
        }
        expect(mockPrisma.webhookSubscription.create).not.toHaveBeenCalled();
      });

      it('drops the URL when the scheme does not sign the body', async () => {
        mockPrisma.webhookSubscription.create.mockResolvedValue({ id: 'wh-1', name: 'boards' });

        await authedRequest(app).post('/agents/webhook-subscriptions').send({
          ...hmacBody,
          authType: 'token',
          authSignedUrl: 'https://prism.example.com/agents/webhooks/boards',
        });

        expect(mockPrisma.webhookSubscription.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ authType: 'token', authSignedUrl: null }),
        });
      });
    });

    // Header and secret are trimmed; the prefix is stored exactly as typed,
    // since only the operator knows what their sender puts on the wire.
    // (Matching tolerates the space either way — see webhook-signature.test.ts.)
    it('stores a prefix verbatim instead of trimming it', async () => {
      mockPrisma.webhookSubscription.create.mockResolvedValue({ id: 'wh-1', name: 'alerts' });

      await authedRequest(app).post('/agents/webhook-subscriptions').send({
        name: 'alerts',
        authType: 'token',
        authHeader: 'Authorization',
        authPrefix: 'Bearer ',
        secret: 'shhh',
      });

      expect(mockPrisma.webhookSubscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ authPrefix: 'Bearer ' }),
      });
    });

    it('rejects an unknown authType, algorithm or encoding', async () => {
      for (const [field, body] of [
        ['authType', { authType: 'github' }],
        ['authAlgorithm', { authType: 'hmac', authHeader: 'X-S', secret: 's', authAlgorithm: 'md5' }],
        ['authEncoding', { authType: 'hmac', authHeader: 'X-S', secret: 's', authEncoding: 'rot13' }],
      ] as const) {
        const res = await authedRequest(app)
          .post('/agents/webhook-subscriptions')
          .send({ name: 'alerts', ...body });
        expect(res.status).toBe(400);
        expect(res.body.fieldErrors[field]).toBeTruthy();
      }
      expect(mockPrisma.webhookSubscription.create).not.toHaveBeenCalled();
    });

    it('rejects a scheme without a secret or a header', async () => {
      const noSecret = await authedRequest(app)
        .post('/agents/webhook-subscriptions')
        .send({ name: 'alerts', authType: 'hmac', authHeader: 'X-Signature' });
      expect(noSecret.status).toBe(400);
      expect(noSecret.body.fieldErrors.secret).toBeTruthy();

      const noHeader = await authedRequest(app)
        .post('/agents/webhook-subscriptions')
        .send({ name: 'alerts', authType: 'token', secret: 'shhh' });
      expect(noHeader.status).toBe(400);
      expect(noHeader.body.fieldErrors.authHeader).toBeTruthy();

      expect(mockPrisma.webhookSubscription.create).not.toHaveBeenCalled();
    });

    it('rejects a non-string secret instead of silently dropping it', async () => {
      const res = await authedRequest(app)
        .post('/agents/webhook-subscriptions')
        .send({ name: 'alerts', authType: 'token', authHeader: 'X-Token', secret: 12345 });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.secret).toBeTruthy();
      expect(mockPrisma.webhookSubscription.create).not.toHaveBeenCalled();
    });

    it('rejects invalid names with a field error', async () => {
      const res = await authedRequest(app)
        .post('/agents/webhook-subscriptions')
        .send({ name: '-leading-hyphen' });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.name).toBeTruthy();
      expect(mockPrisma.webhookSubscription.create).not.toHaveBeenCalled();
    });

    it('rejects unknown deliverTo values with a field error', async () => {
      const res = await authedRequest(app)
        .post('/agents/webhook-subscriptions')
        .send({ name: 'alerts', deliverTo: 'log' });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.deliverTo).toBeTruthy();
    });

    it('stores an agent-mode subscription that delivers nowhere', async () => {
      mockPrisma.webhookSubscription.create.mockResolvedValue({ id: 'wh-1', name: 'reviews', deliverTo: 'none' });

      const res = await authedRequest(app)
        .post('/agents/webhook-subscriptions')
        .send({ name: 'reviews', deliverTo: 'none', authType: 'none' });

      expect(res.status).toBe(201);
      expect(mockPrisma.webhookSubscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ deliverTo: 'none', deliverOnly: false }),
      });
    });

    it('rejects deliver only without a target', async () => {
      const res = await authedRequest(app)
        .post('/agents/webhook-subscriptions')
        .send({ name: 'reviews', deliverTo: 'none', deliverOnly: true, authType: 'none' });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.deliverOnly).toBeTruthy();
      expect(mockPrisma.webhookSubscription.create).not.toHaveBeenCalled();
    });

    it('409s duplicate names', async () => {
      mockPrisma.webhookSubscription.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const res = await authedRequest(app)
        .post('/agents/webhook-subscriptions')
        .send({ name: 'alerts', authType: 'none' });

      expect(res.status).toBe(409);
      expect(res.body.fieldErrors.name).toContain('already taken');
    });
  });

  it.each(['create', 'update'] as const)('keeps Prisma validation details private on %s', async (operation) => {
    vi.spyOn(logger, 'error');
    mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1' });
    mockPrisma.webhookSubscription.findUnique.mockResolvedValue({
      authType: 'token', authHeader: 'Authorization', authPrefix: null,
      authAlgorithm: 'sha256', authEncoding: 'hex', secret: 'demo-old-token',
    });
    mockPrisma.webhookSubscription[operation].mockRejectedValue(
      new Prisma.PrismaClientValidationError('Invalid invocation: data: { secret: "demo-private-token" }', {
        clientVersion: 'test',
      }),
    );
    const response = operation === 'create'
      ? await authedRequest(app).post('/agents/webhook-subscriptions').send({
        name: 'alerts', authHeader: 'Authorization', secret: 'demo-private-token',
      })
      : await authedRequest(app).patch('/agents/webhook-subscriptions/wh-1').send({ secret: 'demo-private-token' });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: `Failed to ${operation} webhook subscription` });
    expect(logger.error).toHaveBeenCalledWith({ errorName: 'PrismaClientValidationError' }, expect.any(String));
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('demo-private-token');
  });

  describe('PATCH /webhook-subscriptions/:id', () => {
    it('toggles isActive', async () => {
      const updated = { id: 'wh-1', isActive: false };
      mockPrisma.webhookSubscription.update.mockResolvedValue(updated);

      const res = await authedRequest(app)
        .patch('/agents/webhook-subscriptions/wh-1')
        .send({ isActive: false });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ...updated, slackChannelIds: [], hasSecret: false });
      expect(mockPrisma.webhookSubscription.update).toHaveBeenCalledWith({
        where: { id: 'wh-1' },
        data: { isActive: false },
      });
      // No auth field in the body → no need to read the row first.
      expect(mockPrisma.webhookSubscription.findUnique).not.toHaveBeenCalled();
    });

    it('edits the delivery fields, clearing a field sent as an empty string', async () => {
      const updated = {
        id: 'wh-1',
        isActive: true,
        deliverTo: 'slack',
        deliverOnly: true,
        authType: 'token',
        secret: 'kept',
      };
      mockPrisma.webhookSubscription.findUnique.mockResolvedValue({ id: 'wh-1', deliverTo: 'all', deliverOnly: false });
      mockPrisma.webhookSubscription.update.mockResolvedValue(updated);

      const res = await authedRequest(app).patch('/agents/webhook-subscriptions/wh-1').send({
        description: '',
        events: ' push, pull_request ',
        prompt: 'Alert: {status}',
        deliverTo: 'slack',
        deliverOnly: true,
      });

      expect(res.status).toBe(200);
      expect(mockPrisma.webhookSubscription.update).toHaveBeenCalledWith({
        where: { id: 'wh-1' },
        data: {
          description: null,
          events: 'push, pull_request',
          prompt: 'Alert: {status}',
          deliverTo: 'slack',
          deliverOnly: true,
        },
      });
      expect(mockTrackEvent).toHaveBeenCalledWith('webhook subscription updated', config.ownerUserId, {
        'agent.id': config.agentId,
        'webhook.subscription_id': 'wh-1',
        'webhook.outcome': 'success',
        'webhook.is_active': 'true',
        'webhook.deliver_to': 'slack',
        'webhook.slack_channels': '0',
        'webhook.deliver_only': 'true',
        'webhook.auth_type': 'token',
      });
    });

    it('keeps a stored channel unlinked since it was chosen, and refuses a new unlinked one', async () => {
      const current = { id: 'wh-1', agentId: 'agent-1', deliverTo: 'slack', slackChannelIds: 'C_GONE' };
      mockPrisma.webhookSubscription.findUnique.mockResolvedValue(current);
      mockSlackMappingService.listChannelIds.mockResolvedValue(['C_REL']);
      mockPrisma.webhookSubscription.update.mockResolvedValue({ ...current, slackChannelIds: 'C_GONE,C_REL' });

      const kept = await authedRequest(app).patch('/agents/webhook-subscriptions/wh-1').send({
        description: 'Release notes',
        slackChannelIds: ['C_GONE', 'C_REL'],
      });
      expect(kept.status).toBe(200);
      expect(mockPrisma.webhookSubscription.update).toHaveBeenCalledWith({
        where: { id: 'wh-1' },
        data: { description: 'Release notes', slackChannelIds: 'C_GONE,C_REL' },
      });

      const refused = await authedRequest(app).patch('/agents/webhook-subscriptions/wh-1').send({
        slackChannelIds: ['C_OTHER'],
      });
      expect(refused.status).toBe(400);
      expect(refused.body.fieldErrors.slackChannelIds).toContain('C_OTHER');
      expect(mockPrisma.webhookSubscription.update).toHaveBeenCalledTimes(1);
    });

    it('clears the channel list sent as null', async () => {
      mockPrisma.webhookSubscription.findUnique.mockResolvedValue({
        id: 'wh-1',
        agentId: 'agent-1',
        deliverTo: 'slack',
        deliverOnly: false,
        slackChannelIds: 'C_REL',
      });
      mockPrisma.webhookSubscription.update.mockResolvedValue({ id: 'wh-1', deliverTo: 'slack' });

      const res = await authedRequest(app).patch('/agents/webhook-subscriptions/wh-1').send({
        slackChannelIds: null,
      });

      expect(res.status).toBe(200);
      expect(mockPrisma.webhookSubscription.update).toHaveBeenCalledWith({
        where: { id: 'wh-1' },
        data: { slackChannelIds: null },
      });
    });

    it('judges the list against the target the same request sets', async () => {
      mockPrisma.webhookSubscription.findUnique.mockResolvedValue({
        id: 'wh-1',
        agentId: 'agent-1',
        deliverTo: 'slack',
        slackChannelIds: null,
      });

      const res = await authedRequest(app).patch('/agents/webhook-subscriptions/wh-1').send({
        deliverTo: 'chat',
        slackChannelIds: ['C_REL'],
      });

      expect(res.status).toBe(400);
      expect(mockPrisma.webhookSubscription.update).not.toHaveBeenCalled();
    });

    it('clears the channel list when the target moves off Slack', async () => {
      mockPrisma.webhookSubscription.findUnique.mockResolvedValue({
        id: 'wh-1',
        agentId: 'agent-1',
        deliverTo: 'slack',
        deliverOnly: false,
        slackChannelIds: 'C_REL',
      });
      mockPrisma.webhookSubscription.update.mockResolvedValue({ id: 'wh-1', deliverTo: 'chat' });

      const res = await authedRequest(app).patch('/agents/webhook-subscriptions/wh-1').send({
        deliverTo: 'chat',
      });

      expect(res.status).toBe(200);
      expect(mockPrisma.webhookSubscription.update).toHaveBeenCalledWith({
        where: { id: 'wh-1' },
        data: { deliverTo: 'chat', slackChannelIds: null },
      });
    });

    it.each([
      {
        outcome: 'invalid',
        status: 400,
        body: { deliverTo: 'pager' },
        arrange: () => {},
      },
      {
        outcome: 'not_found',
        status: 404,
        body: { isActive: true },
        arrange: () =>
          mockPrisma.webhookSubscription.update.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('Not found', { code: 'P2025', clientVersion: 'test' }),
          ),
      },
      {
        outcome: 'error',
        status: 500,
        body: { isActive: true },
        arrange: () => mockPrisma.webhookSubscription.update.mockRejectedValue(new Error('disk I/O error')),
      },
    ])('records a $status answer as outcome $outcome', async ({ outcome, status, body, arrange }) => {
      arrange();

      const res = await authedRequest(app).patch('/agents/webhook-subscriptions/wh-1').send(body);

      expect(res.status).toBe(status);
      expect(mockTrackEvent).toHaveBeenCalledWith('webhook subscription updated', config.ownerUserId, {
        'agent.id': config.agentId,
        'webhook.subscription_id': 'wh-1',
        'webhook.outcome': outcome,
      });
    });

    describe('delivery fields', () => {
      it('switches an agent-mode subscription to deliver nowhere', async () => {
        mockPrisma.webhookSubscription.findUnique.mockResolvedValue({ id: 'wh-1', deliverTo: 'slack', deliverOnly: false });
        mockPrisma.webhookSubscription.update.mockResolvedValue({ id: 'wh-1', deliverTo: 'none' });

        const res = await authedRequest(app)
          .patch('/agents/webhook-subscriptions/wh-1')
          .send({ deliverTo: 'none' });

        expect(res.status).toBe(200);
        expect(mockPrisma.webhookSubscription.update).toHaveBeenCalledWith({
          where: { id: 'wh-1' },
          data: { deliverTo: 'none', slackChannelIds: null },
        });
      });

      it('validates the effective result: a deliver-only row cannot lose its target', async () => {
        mockPrisma.webhookSubscription.findUnique.mockResolvedValue({ id: 'wh-1', deliverTo: 'all', deliverOnly: true });

        const res = await authedRequest(app)
          .patch('/agents/webhook-subscriptions/wh-1')
          .send({ deliverTo: 'none' });

        expect(res.status).toBe(400);
        expect(res.body.fieldErrors.deliverOnly).toBeTruthy();
        expect(mockPrisma.webhookSubscription.update).not.toHaveBeenCalled();
        expect(mockTrackEvent).toHaveBeenCalledWith(
          'webhook subscription updated',
          config.ownerUserId,
          expect.objectContaining({ 'webhook.outcome': 'invalid' }),
        );
      });

      it('validates the effective result: a row with no target cannot turn on deliver only', async () => {
        mockPrisma.webhookSubscription.findUnique.mockResolvedValue({ id: 'wh-1', deliverTo: 'none', deliverOnly: false });

        const res = await authedRequest(app)
          .patch('/agents/webhook-subscriptions/wh-1')
          .send({ deliverOnly: true });

        expect(res.status).toBe(400);
        expect(mockPrisma.webhookSubscription.update).not.toHaveBeenCalled();
      });
    });

    describe('auth fields', () => {
      const stored = {
        id: 'wh-1',
        name: 'alerts',
        authType: 'hmac',
        authHeader: 'X-Signature',
        authPrefix: 'sha256=',
        authAlgorithm: 'sha256',
        authEncoding: 'hex',
        secret: 'old-secret',
      };

      it('rotates the secret while keeping the rest of the configuration', async () => {
        mockPrisma.webhookSubscription.findUnique.mockResolvedValue(stored);
        mockPrisma.webhookSubscription.update.mockResolvedValue({ ...stored, secret: 'new-secret' });

        const res = await authedRequest(app)
          .patch('/agents/webhook-subscriptions/wh-1')
          .send({ secret: 'new-secret' });

        expect(res.status).toBe(200);
        expect(mockPrisma.webhookSubscription.update).toHaveBeenCalledWith({
          where: { id: 'wh-1' },
          data: expect.objectContaining({
            authType: 'hmac',
            authHeader: 'X-Signature',
            secret: 'new-secret',
          }),
        });
        expect(res.body).not.toHaveProperty('secret');
        expect(res.body.hasSecret).toBe(true);
      });

      it('writes only auth fields, never the rest of the row it just read', async () => {
        // The handler reads the row to validate the effective result; carrying
        // that read into the update payload would write back stale values
        // (clobbering a concurrent isActive toggle, pinning updatedAt).
        mockPrisma.webhookSubscription.findUnique.mockResolvedValue({
          ...stored,
          agentId: 'agent-1',
          description: 'from the read',
          events: null,
          prompt: 'from the read',
          deliverTo: 'all',
          deliverOnly: false,
          isActive: true,
          createdAt: new Date('2026-01-01'),
          updatedAt: new Date('2026-01-02'),
        });
        mockPrisma.webhookSubscription.update.mockResolvedValue(stored);

        await authedRequest(app)
          .patch('/agents/webhook-subscriptions/wh-1')
          .send({ secret: 'new-secret' });

        const { data } = mockPrisma.webhookSubscription.update.mock.calls[0][0];
        expect(Object.keys(data).sort()).toEqual([
          'authAlgorithm',
          'authEncoding',
          'authHeader',
          'authPrefix',
          'authSignedUrl',
          'authType',
          'secret',
        ]);
      });

      it('validates the effective result, not just the patch', async () => {
        // Row currently has no credential; switching it to 'hmac' alone would
        // leave an endpoint that demands verification it cannot perform.
        mockPrisma.webhookSubscription.findUnique.mockResolvedValue({
          ...stored,
          authType: 'none',
          authHeader: null,
          secret: null,
        });

        const res = await authedRequest(app)
          .patch('/agents/webhook-subscriptions/wh-1')
          .send({ authType: 'hmac', authHeader: 'X-Signature' });

        expect(res.status).toBe(400);
        expect(res.body.fieldErrors.secret).toBeTruthy();
        expect(mockPrisma.webhookSubscription.update).not.toHaveBeenCalled();
      });

      it('sets the signed URL on an HMAC subscription', async () => {
        const url = 'https://prism.example.com/agents/webhooks/alerts';
        mockPrisma.webhookSubscription.findUnique.mockResolvedValue({ ...stored, authSignedUrl: null });
        mockPrisma.webhookSubscription.update.mockResolvedValue({ ...stored, authSignedUrl: url });

        const res = await authedRequest(app)
          .patch('/agents/webhook-subscriptions/wh-1')
          .send({ authSignedUrl: url });

        expect(res.status).toBe(200);
        expect(mockPrisma.webhookSubscription.update).toHaveBeenCalledWith({
          where: { id: 'wh-1' },
          data: expect.objectContaining({ authType: 'hmac', authSignedUrl: url, secret: 'old-secret' }),
        });
      });

      // The edit dialog sends '' when the field is emptied.
      it('clears the signed URL when it is sent empty', async () => {
        mockPrisma.webhookSubscription.findUnique.mockResolvedValue({
          ...stored,
          authSignedUrl: 'https://prism.example.com/agents/webhooks/alerts',
        });
        mockPrisma.webhookSubscription.update.mockResolvedValue({ ...stored, authSignedUrl: null });

        const res = await authedRequest(app)
          .patch('/agents/webhook-subscriptions/wh-1')
          .send({ authSignedUrl: '' });

        expect(res.status).toBe(200);
        expect(mockPrisma.webhookSubscription.update).toHaveBeenCalledWith({
          where: { id: 'wh-1' },
          data: expect.objectContaining({ authType: 'hmac', authSignedUrl: null }),
        });
      });

      it('clears the stored credential when verification is switched off', async () => {
        mockPrisma.webhookSubscription.findUnique.mockResolvedValue(stored);
        mockPrisma.webhookSubscription.update.mockResolvedValue({
          ...stored,
          authType: 'none',
          secret: null,
        });

        const res = await authedRequest(app)
          .patch('/agents/webhook-subscriptions/wh-1')
          .send({ authType: 'none' });

        expect(res.status).toBe(200);
        expect(mockPrisma.webhookSubscription.update).toHaveBeenCalledWith({
          where: { id: 'wh-1' },
          data: expect.objectContaining({
            authType: 'none',
            authHeader: null,
            authPrefix: null,
            secret: null,
          }),
        });
        expect(res.body.hasSecret).toBe(false);
      });

      it('404s before validating when the row is gone', async () => {
        mockPrisma.webhookSubscription.findUnique.mockResolvedValue(null);

        const res = await authedRequest(app)
          .patch('/agents/webhook-subscriptions/wh-missing')
          .send({ authType: 'none' });

        expect(res.status).toBe(404);
        expect(mockPrisma.webhookSubscription.update).not.toHaveBeenCalled();
      });
    });

    it('400s when no updatable fields are provided', async () => {
      const res = await authedRequest(app)
        .patch('/agents/webhook-subscriptions/wh-1')
        .send({ bogus: true });

      expect(res.status).toBe(400);
      expect(mockPrisma.webhookSubscription.update).not.toHaveBeenCalled();
    });

    it('404s a missing subscription', async () => {
      mockPrisma.webhookSubscription.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Not found', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      const res = await authedRequest(app)
        .patch('/agents/webhook-subscriptions/wh-missing')
        .send({ isActive: true });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /webhook-subscriptions/:id', () => {
    it('deletes and reports success', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1' });
      mockPrisma.webhookSubscription.delete.mockResolvedValue({ id: 'wh-1' });

      const res = await authedRequest(app).delete('/agents/webhook-subscriptions/wh-1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it('still reports success when telemetry lookup fails after the delete', async () => {
      mockPrisma.webhookSubscription.delete.mockResolvedValue({ id: 'wh-1' });
      mockGetAgent.mockRejectedValue(new Error('agent lookup exploded'));

      const res = await authedRequest(app).delete('/agents/webhook-subscriptions/wh-1');

      // The destructive action already succeeded — telemetry is best-effort.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it('404s a missing subscription', async () => {
      mockPrisma.webhookSubscription.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Not found', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      const res = await authedRequest(app).delete('/agents/webhook-subscriptions/wh-missing');

      expect(res.status).toBe(404);
    });
  });

  // ==========================================================================
  // POST /threads/get-or-create-latest
  // ==========================================================================

  describe('POST /threads/get-or-create-latest', () => {
    it('returns the thread on success', async () => {
      const thread = { id: 'thread-1', agentId: 'agent-1', userId: 'user-1' };
      mockGetOrCreateLatestThread.mockResolvedValue(thread);

      const res = await authedRequest(app)
        .post('/agents/threads/get-or-create-latest')
        .send({ agentId: 'agent-1', userId: 'user-1' });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('thread-1');
      expect(mockGetOrCreateLatestThread).toHaveBeenCalledWith('agent-1', 'user-1');
    });

    it('returns 400 when agentId is missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/threads/get-or-create-latest')
        .send({ userId: 'user-1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('agentId');
    });

    it('returns 400 when userId is missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/threads/get-or-create-latest')
        .send({ agentId: 'agent-1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('userId');
    });

    it('returns 500 when getOrCreateLatestThread throws', async () => {
      mockGetOrCreateLatestThread.mockRejectedValue(new Error('DB error'));

      const res = await authedRequest(app)
        .post('/agents/threads/get-or-create-latest')
        .send({ agentId: 'agent-1', userId: 'user-1' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  // ==========================================================================
  // POST /threads
  // ==========================================================================

  describe('POST /threads', () => {
    it('returns the thread on success', async () => {
      const thread = { id: 'thread-1', agentId: 'agent-1', userId: 'user-1' };
      mockGetOrCreateFreshThread.mockResolvedValue(thread);

      const res = await authedRequest(app)
        .post('/agents/threads')
        .send({ agentId: 'agent-1', userId: 'user-1' });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('thread-1');
      expect(mockGetOrCreateFreshThread).toHaveBeenCalledWith('agent-1', 'user-1');
    });

    it('returns 400 when agentId is missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/threads')
        .send({ userId: 'user-1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('agentId');
    });

    it('returns 400 when userId is missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/threads')
        .send({ agentId: 'agent-1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('userId');
    });

    it('returns 500 when getOrCreateFreshThread throws', async () => {
      mockGetOrCreateFreshThread.mockRejectedValue(new Error('DB error'));

      const res = await authedRequest(app)
        .post('/agents/threads')
        .send({ agentId: 'agent-1', userId: 'user-1' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  // ==========================================================================
  // GET /threads
  // ==========================================================================

  describe('GET /threads', () => {
    it('returns 400 when userId is missing', async () => {
      const res = await authedRequest(app)
        .get('/agents/threads?agentId=agent-1');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('userId');
    });

    it('returns 400 when agentId is missing', async () => {
      const res = await authedRequest(app)
        .get('/agents/threads?userId=user-1');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('agentId');
    });

    it('returns threads on success', async () => {
      const threads = [
        { id: 'thread-1', title: 'Debugging session' },
        { id: 'thread-2', title: 'Security review' },
      ];
      mockListThreads.mockResolvedValue(threads);

      const res = await authedRequest(app)
        .get('/agents/threads?userId=user-1&agentId=agent-1');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].id).toBe('thread-1');
      expect(mockListThreads).toHaveBeenCalledWith('user-1', 'agent-1', {
        limit: undefined,
        threadSource: undefined,
      });
    });

    it('passes the limit query param', async () => {
      mockListThreads.mockResolvedValue([]);

      const res = await authedRequest(app)
        .get('/agents/threads?userId=user-1&agentId=agent-1&limit=5');

      expect(res.status).toBe(200);
      expect(mockListThreads).toHaveBeenCalledWith('user-1', 'agent-1', {
        limit: 5,
        threadSource: undefined,
      });
    });

    it('forwards threadSource=DATABASE to drop channel threads', async () => {
      mockListThreads.mockResolvedValue([]);

      const res = await authedRequest(app)
        .get('/agents/threads?userId=user-1&agentId=agent-1&threadSource=DATABASE');

      expect(res.status).toBe(200);
      expect(mockListThreads).toHaveBeenCalledWith('user-1', 'agent-1', {
        limit: undefined,
        threadSource: 'DATABASE',
      });
    });

    it('ignores an unknown threadSource value (no channel filter)', async () => {
      mockListThreads.mockResolvedValue([]);

      const res = await authedRequest(app)
        .get('/agents/threads?userId=user-1&agentId=agent-1&threadSource=BOGUS');

      expect(res.status).toBe(200);
      expect(mockListThreads).toHaveBeenCalledWith('user-1', 'agent-1', {
        limit: undefined,
        threadSource: undefined,
      });
    });

    it('returns 500 when listThreads throws', async () => {
      mockListThreads.mockRejectedValue(new Error('DB error'));

      const res = await authedRequest(app)
        .get('/agents/threads?userId=user-1&agentId=agent-1');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  // ==========================================================================
  // GET /threads/:threadId
  // ==========================================================================

  describe('GET /threads/:threadId', () => {
    it('returns 400 when userId is missing', async () => {
      const res = await authedRequest(app)
        .get('/agents/threads/thread-1?agentId=agent-1');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('userId');
    });

    it('returns 400 when agentId is missing', async () => {
      const res = await authedRequest(app)
        .get('/agents/threads/thread-1?userId=user-1');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('agentId');
    });

    it('returns 404 when thread is not found', async () => {
      mockGetThread.mockResolvedValue(null);

      const res = await authedRequest(app)
        .get('/agents/threads/thread-1?userId=user-1&agentId=agent-1');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Thread not found');
      expect(mockGetThread).toHaveBeenCalledWith('user-1', 'agent-1', 'thread-1', undefined);
    });

    it('returns thread with messages on success', async () => {
      const thread = {
        id: 'thread-1',
        userId: 'user-1',
        agentId: 'agent-1',
        messages: [
          { id: 'msg-1', role: 'USER', content: 'Hello' },
          { id: 'msg-2', role: 'AGENT', content: 'Hi there!' },
        ],
      };
      mockGetThread.mockResolvedValue(thread);

      const res = await authedRequest(app)
        .get('/agents/threads/thread-1?userId=user-1&agentId=agent-1');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('thread-1');
      expect(res.body.messages).toHaveLength(2);
      expect(mockGetThread).toHaveBeenCalledWith('user-1', 'agent-1', 'thread-1', undefined);
    });

    it('reads one page of history when a limit is given', async () => {
      mockGetThread.mockResolvedValue({ id: 'thread-1', messages: [] });

      const res = await authedRequest(app)
        .get('/agents/threads/thread-1?userId=user-1&agentId=agent-1&limit=50&before=msg-9');

      expect(res.status).toBe(200);
      expect(mockGetThread).toHaveBeenCalledWith('user-1', 'agent-1', 'thread-1', { limit: 50, before: 'msg-9' });
    });

    it('returns 500 when getThread throws', async () => {
      mockGetThread.mockRejectedValue(new Error('DB error'));

      const res = await authedRequest(app)
        .get('/agents/threads/thread-1?userId=user-1&agentId=agent-1');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  // ==========================================================================
  // POST /threads/:threadId/messages
  // ==========================================================================

  describe('POST /threads/:threadId/messages', () => {
    it('returns 400 when required fields are missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/threads/thread-1/messages')
        .send({ content: 'Hello' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('role');
      expect(res.body.error).toContain('triggeredBy');
    });

    it('returns 201 with the created message on success', async () => {
      const message = {
        id: 'msg-1',
        threadId: 'thread-1',
        role: 'USER',
        content: 'Hello',
        triggeredBy: 'USER_INPUT',
        createdAt: '2026-01-01T00:00:00Z',
      };
      mockAddMessage.mockResolvedValue({ message, titleSet: null });

      const res = await authedRequest(app)
        .post('/agents/threads/thread-1/messages')
        .send({ content: 'Hello', role: 'USER', triggeredBy: 'USER_INPUT' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('msg-1');
      expect(res.body.content).toBe('Hello');
      expect(mockAddMessage).toHaveBeenCalledWith('thread-1', {
        content: 'Hello',
        role: 'USER',
        triggeredBy: 'USER_INPUT',
        toolCalls: undefined,
        blocks: undefined,
        senderExternalId: undefined,
        senderName: undefined,
      });
    });

    it('refuses SYSTEM, which the database still declares but nothing produces', async () => {
      // The Prisma enum keeps SYSTEM so a historical row stays readable. Validating
      // against it would let a caller write a new one, which is why this route
      // validates against the runtime's own list instead.
      const res = await authedRequest(app)
        .post('/agents/threads/thread-1/messages')
        .send({ content: 'Hello', role: 'AGENT', triggeredBy: 'SYSTEM' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid triggeredBy: SYSTEM');
      expect(mockAddMessage).not.toHaveBeenCalled();
    });

    it('returns 500 when addMessage throws', async () => {
      mockAddMessage.mockRejectedValue(new Error('DB error'));

      const res = await authedRequest(app)
        .post('/agents/threads/thread-1/messages')
        .send({ content: 'Hello', role: 'USER', triggeredBy: 'USER_INPUT' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  // ==========================================================================
  // POST /threads/:threadId/set-external-id
  // ==========================================================================

  describe('POST /threads/:threadId/set-external-id', () => {
    it('sets external ID and returns success', async () => {
      mockSetExternalId.mockResolvedValue(undefined);

      const res = await authedRequest(app)
        .post('/agents/threads/thread-1/set-external-id')
        .send({ externalThreadId: '1234.5678' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSetExternalId).toHaveBeenCalledWith('thread-1', '1234.5678');
    });

    it('returns 400 when externalThreadId is missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/threads/thread-1/set-external-id')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('externalThreadId');
    });

    it('returns 500 when setExternalId throws', async () => {
      mockSetExternalId.mockRejectedValue(new Error('DB error'));

      const res = await authedRequest(app)
        .post('/agents/threads/thread-1/set-external-id')
        .send({ externalThreadId: '1234.5678' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  // ==========================================================================
  // Backup / restore
  // ==========================================================================

  describe('backup / restore', () => {
    it('GET /agents/export streams a gzipped snapshot', async () => {
        mockGetAgent.mockResolvedValue({ id: 'agent-1', name: 'My Bot' });
        const { Readable } = await import('stream');
        const payload = Buffer.from('fake-gzip-payload');
        const cleanup = vi.fn();
        mockExportAgent.mockResolvedValue({
          stream: Readable.from([payload]),
          filename: 'my-bot-20260513-1200.prism',
          cleanup,
        });

        const res = await request(app).get('/agents/export').buffer(true);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/octet-stream');
        expect(res.headers['content-disposition']).toContain('my-bot-20260513-1200.prism');
        expect(mockExportAgent).toHaveBeenCalledWith('My Bot');
      });

      it('GET /agents/export returns 500 when agent is missing', async () => {
        mockGetAgent.mockRejectedValue(new Error('Agent not found'));
        const res = await request(app).get('/agents/export');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Agent not found');
        expect(mockExportAgent).not.toHaveBeenCalled();
      });

      it('POST /agents/import stages the archive and signals restart', async () => {
        mockGetAgent.mockResolvedValue({ id: 'agent-1', name: 'My Bot' });
        mockImportAgent.mockResolvedValue(undefined);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

        const res = await request(app)
          .post('/agents/import')
          .attach('file', Buffer.from('upload-bytes'), 'backup.prism');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, restarting: true });
        expect(mockImportAgent).toHaveBeenCalledOnce();
        const calledWith = mockImportAgent.mock.calls[0]?.[0] as Buffer;
        expect(Buffer.isBuffer(calledWith)).toBe(true);
        expect(calledWith.toString()).toBe('upload-bytes');

        // process.exit is scheduled on a 100ms setTimeout after res.finish; let
        // the macro-task queue drain so the spy actually fires.
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(exitSpy).toHaveBeenCalledWith(0);
        exitSpy.mockRestore();
      });

      it('POST /agents/import returns 400 when validation fails', async () => {
        mockGetAgent.mockResolvedValue({ id: 'agent-1', name: 'My Bot' });
        const { ArchiveValidationError } = await import('../services/agent-archive.service');
        mockImportAgent.mockRejectedValue(new ArchiveValidationError('Schema version mismatch'));

        const res = await request(app)
          .post('/agents/import')
          .attach('file', Buffer.from('bad-bytes'), 'backup.prism');

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Schema version mismatch');
      });

      it('POST /agents/import returns 400 when the file field is missing', async () => {
        mockGetAgent.mockResolvedValue({ id: 'agent-1', name: 'My Bot' });

        const res = await request(app).post('/agents/import');

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Missing');
        expect(mockImportAgent).not.toHaveBeenCalled();
      });
  });

  // ==========================================================================
  // Attachments (shared files)
  // ==========================================================================

  describe('Attachments', () => {
    it('POST /agents/attachments stores a file and returns metadata (no bytes)', async () => {
      mockAttachmentCreate.mockResolvedValue({
        id: 'att-1',
        filename: 'notes.txt',
        mediaType: 'text/plain',
        sizeBytes: 5,
        category: 'text',
      });

      const res = await authedRequest(app)
        .post('/agents/attachments')
        .attach('file', Buffer.from('hello'), 'notes.txt');

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: 'att-1',
        filename: 'notes.txt',
        mediaType: 'text/plain',
        sizeBytes: 5,
        category: 'text',
      });
      expect(res.body.data).toBeUndefined();
      // Route ran real detection/classification before persisting.
      expect(mockAttachmentCreate).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'notes.txt', mediaType: 'text/plain', category: 'text', source: 'web' }),
      );
    });

    it('POST /agents/attachments returns 400 when no file is provided', async () => {
      const res = await authedRequest(app).post('/agents/attachments');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing');
      expect(mockAttachmentCreate).not.toHaveBeenCalled();
    });

    it('GET /agents/attachments/:id streams bytes with content-type and disposition', async () => {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      mockAttachmentGetById.mockResolvedValue({
        id: 'att-1',
        filename: 'pic.png',
        mediaType: 'image/png',
        storagePath: 'att-1-pic.png',
      });
      mockAttachmentLoadBytes.mockResolvedValue(bytes);

      const res = await authedRequest(app).get('/agents/attachments/att-1');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
      expect(res.headers['content-disposition']).toContain('pic.png');
      expect(Buffer.from(res.body)).toEqual(bytes);
    });

    it('GET /agents/attachments/:id returns 404 when not found', async () => {
      mockAttachmentGetById.mockResolvedValue(null);
      const res = await authedRequest(app).get('/agents/attachments/missing');
      expect(res.status).toBe(404);
    });

    it('GET /agents/attachments/:id returns 410 when the content has expired', async () => {
      mockAttachmentGetById.mockResolvedValue({
        id: 'att-1',
        filename: 'old.pdf',
        mediaType: 'application/pdf',
        storagePath: null,
        data: null,
      });
      mockAttachmentLoadBytes.mockResolvedValue(null);

      const res = await authedRequest(app).get('/agents/attachments/att-1');

      expect(res.status).toBe(410);
      expect(res.body.error).toContain('expired');
    });

    it('GET /agents/attachments/:id survives non-latin1 filenames (RFC 5987)', async () => {
      // Node's setHeader throws ERR_INVALID_CHAR for header values outside
      // latin-1, so a raw unicode filename= would 500 the download.
      mockAttachmentGetById.mockResolvedValue({
        id: 'att-1',
        filename: '日本語 (1).pdf',
        mediaType: 'application/pdf',
        storagePath: 'att-1-file.pdf',
      });
      mockAttachmentLoadBytes.mockResolvedValue(Buffer.from('%PDF'));

      const res = await authedRequest(app).get('/agents/attachments/att-1');

      expect(res.status).toBe(200);
      const disposition = res.headers['content-disposition'];
      // ASCII fallback in filename= (unicode replaced), real name in filename*
      // (parens percent-encoded — not RFC 5987 attr-chars).
      expect(disposition).toContain('filename="___ (1).pdf"');
      expect(disposition).toContain("filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E%20%281%29.pdf");
    });

    it('DELETE /agents/attachments/:id removes an unlinked attachment', async () => {
      mockAttachmentDeleteUnlinked.mockResolvedValue(1);
      const res = await authedRequest(app).delete('/agents/attachments/att-1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('DELETE /agents/attachments/:id returns 404 when nothing was deleted (linked/missing)', async () => {
      mockAttachmentDeleteUnlinked.mockResolvedValue(0);
      const res = await authedRequest(app).delete('/agents/attachments/att-1');
      expect(res.status).toBe(404);
    });
  });

  // ==========================================================================
  // Skills (GET /skills, POST /skills/:name/run)
  // ==========================================================================

  describe('Skills Routes', () => {
    beforeEach(() => {
      // The global config mock has agentId but no ownerUserId; the skills run
      // route reads both. Restore them before each test (the 503 case mutates
      // agentId).
      config.agentId = 'test-agent-id';
      (config as unknown as { ownerUserId: string }).ownerUserId = 'owner-user-id';
      // Default: threads have no workspace root (global skills only).
      mockGetThreadWorkspaceRoot.mockResolvedValue(null);
      mockFindLatestWebThread.mockResolvedValue(null);
    });

    it('GET /skills returns name/description/dirName/source (no bodies); no threadId → latest thread workspace', async () => {
      mockGetCatalog.mockReturnValue([
        { name: 'echo', description: 'Echo it.', dirName: 'echo', dir: '/d/skills/echo', skillMdPath: '/d/skills/echo/SKILL.md', source: 'global' },
        { name: 'greet', description: 'Greet.', dirName: 'greet', dir: '/d/skills/greet', skillMdPath: '/d/skills/greet/SKILL.md', source: 'global' },
      ]);

      const res = await authedRequest(app).get('/agents/skills');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { name: 'echo', description: 'Echo it.', dirName: 'echo', source: 'global' },
        { name: 'greet', description: 'Greet.', dirName: 'greet', source: 'global' },
      ]);
      // No threadId → latest thread (null here) → global-only catalog.
      expect(mockGetCatalog).toHaveBeenCalledWith(undefined);
      expect(mockGetOwnedThreadId).not.toHaveBeenCalled();
    });

    it('GET /skills with no threadId falls back to the latest thread\'s workspace', async () => {
      mockFindLatestWebThread.mockResolvedValue({ id: 'latest', workspaceRoot: '/repo' });
      mockGetCatalog.mockReturnValue([
        { name: 'repo-skill', description: 'r', dirName: 'repo-skill', dir: '/repo/.claude/skills/repo-skill', skillMdPath: '/repo/.claude/skills/repo-skill/SKILL.md', source: 'workspace' },
      ]);

      const res = await authedRequest(app).get('/agents/skills');

      expect(res.status).toBe(200);
      expect(mockGetCatalog).toHaveBeenCalledWith('/repo');
      expect(res.body[0]).toMatchObject({ name: 'repo-skill', source: 'workspace' });
    });

    it('GET /skills?threadId merges the thread\'s workspace skills', async () => {
      mockGetOwnedThreadId.mockResolvedValue('thread-x');
      mockGetThreadWorkspaceRoot.mockResolvedValue('/repo');
      mockGetCatalog.mockReturnValue([
        { name: 'repo-skill', description: 'From the repo.', dirName: 'repo-skill', dir: '/repo/.claude/skills/repo-skill', skillMdPath: '/repo/.claude/skills/repo-skill/SKILL.md', source: 'workspace' },
        { name: 'echo', description: 'Echo it.', dirName: 'echo', dir: '/d/skills/echo', skillMdPath: '/d/skills/echo/SKILL.md', source: 'global' },
      ]);

      const res = await authedRequest(app).get('/agents/skills?threadId=thread-x');

      expect(res.status).toBe(200);
      expect(mockGetOwnedThreadId).toHaveBeenCalledWith('owner-user-id', 'test-agent-id', 'thread-x');
      expect(mockGetCatalog).toHaveBeenCalledWith('/repo');
      expect(res.body).toEqual([
        { name: 'repo-skill', description: 'From the repo.', dirName: 'repo-skill', source: 'workspace' },
        { name: 'echo', description: 'Echo it.', dirName: 'echo', source: 'global' },
      ]);
    });

    it('GET /skills returns 500 when the catalog throws', async () => {
      mockGetCatalog.mockImplementation(() => {
        throw new Error('fs boom');
      });

      const res = await authedRequest(app).get('/agents/skills');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('fs boom');
    });

    it('POST /skills/:name/run runs in the latest thread when no threadId given', async () => {
      mockFind.mockReturnValue({ name: 'echo-marker', dirName: 'echo-marker' });
      mockGetOrCreateLatestThread.mockResolvedValue({ id: 'latest-thread' });
      mockChatEngine.mockResolvedValue({});

      const res = await authedRequest(app).post('/agents/skills/echo-marker/run');

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ threadId: 'latest-thread', skill: 'echo-marker' });
      expect(mockGetOwnedThreadId).not.toHaveBeenCalled();
      expect(mockChatEngine).toHaveBeenCalledWith({
        userId: 'owner-user-id',
        agentId: 'test-agent-id',
        message: 'Use the "echo-marker" skill.',
        threadId: 'latest-thread',
        metadata: { channel: 'websocket' },
      });
    });

    it('POST /skills/:name/run runs in a specific, ownership-checked thread when given', async () => {
      mockFind.mockReturnValue({ name: 'echo-marker', dirName: 'echo-marker' });
      mockGetOwnedThreadId.mockResolvedValue('thread-x');
      mockChatEngine.mockResolvedValue({});

      const res = await authedRequest(app)
        .post('/agents/skills/echo-marker/run')
        .send({ threadId: 'thread-x' });

      expect(res.status).toBe(202);
      expect(mockGetOwnedThreadId).toHaveBeenCalledWith('owner-user-id', 'test-agent-id', 'thread-x');
      expect(mockGetOrCreateLatestThread).not.toHaveBeenCalled();
      expect(mockChatEngine).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-x' }));
    });

    it('POST /skills/:name/run resolves the skill against the thread\'s workspace', async () => {
      mockGetOwnedThreadId.mockResolvedValue('thread-x');
      mockGetThreadWorkspaceRoot.mockResolvedValue('/repo');
      mockFind.mockReturnValue({ name: 'repo-skill', dirName: 'repo-skill' });
      mockChatEngine.mockResolvedValue({});

      const res = await authedRequest(app)
        .post('/agents/skills/repo-skill/run')
        .send({ threadId: 'thread-x' });

      expect(res.status).toBe(202);
      // find() must be called with the thread's workspaceRoot so a repo skill resolves.
      expect(mockFind).toHaveBeenCalledWith('repo-skill', '/repo');
      expect(res.body).toEqual({ threadId: 'thread-x', skill: 'repo-skill' });
    });

    it('POST /skills/:name/run returns 404 for an unknown skill and never starts a turn', async () => {
      mockGetOrCreateLatestThread.mockResolvedValue({ id: 'latest-thread' });
      mockFind.mockReturnValue(undefined);

      const res = await authedRequest(app).post('/agents/skills/nope/run');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('No available skill named "nope"');
      expect(mockChatEngine).not.toHaveBeenCalled();
    });

    it('POST /skills/:name/run returns 404 when the requested thread is not owned', async () => {
      mockFind.mockReturnValue({ name: 'echo-marker', dirName: 'echo-marker' });
      mockGetOwnedThreadId.mockResolvedValue(null);

      const res = await authedRequest(app)
        .post('/agents/skills/echo-marker/run')
        .send({ threadId: 'nope' });

      expect(res.status).toBe(404);
      expect(mockChatEngine).not.toHaveBeenCalled();
    });

    it('POST /skills/:name/run returns 503 when the agent is not initialized', async () => {
      config.agentId = undefined as unknown as string;

      const res = await authedRequest(app).post('/agents/skills/echo-marker/run');

      expect(res.status).toBe(503);
      expect(mockFind).not.toHaveBeenCalled();
      expect(mockChatEngine).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // POST /threads/:threadId/compact
  // ==========================================================================

  describe('POST /threads/:threadId/compact', () => {
    beforeEach(() => {
      config.agentId = 'test-agent-id';
      (config as unknown as { ownerUserId: string }).ownerUserId = 'owner-user-id';
      mockCompactNow.mockResolvedValue(undefined);
    });

    it('returns 202 and fires compactNow for an owned thread', async () => {
      mockGetOwnedThreadId.mockResolvedValue('thread-x');
      mockHasCompactableHistory.mockResolvedValue(true);

      const res = await authedRequest(app).post('/agents/threads/thread-x/compact');

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ threadId: 'thread-x' });
      expect(mockGetOwnedThreadId).toHaveBeenCalledWith('owner-user-id', 'test-agent-id', 'thread-x');
      expect(mockCompactNow).toHaveBeenCalledWith({
        userId: 'owner-user-id',
        agentId: 'test-agent-id',
        threadId: 'thread-x',
      });
    });

    it('returns 404 for a thread the agent does not own', async () => {
      mockGetOwnedThreadId.mockResolvedValue(null);

      const res = await authedRequest(app).post('/agents/threads/nope/compact');

      expect(res.status).toBe(404);
      expect(mockCompactNow).not.toHaveBeenCalled();
    });

    it('returns 409 when there is nothing to compact', async () => {
      mockGetOwnedThreadId.mockResolvedValue('thread-x');
      mockHasCompactableHistory.mockResolvedValue(false);

      const res = await authedRequest(app).post('/agents/threads/thread-x/compact');

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Nothing to compact yet.');
      expect(mockCompactNow).not.toHaveBeenCalled();
    });

    it('returns 503 when the agent is not initialized', async () => {
      config.agentId = undefined as unknown as string;

      const res = await authedRequest(app).post('/agents/threads/thread-x/compact');

      expect(res.status).toBe(503);
      expect(mockCompactNow).not.toHaveBeenCalled();
    });
  });
});
