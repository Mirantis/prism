/**
 * Management Routes Tests
 *
 * Tests for all route handlers: heartbeat start/stop/trigger/status,
 * cron schedule/unschedule, auth validation, and error responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockStartHeartbeat,
  mockStopHeartbeat,
  mockTriggerHeartbeat,
  mockGetStatus,
  mockScheduleTask,
  mockUnscheduleTask,
  mockGetAgent,
  mockGetThread,
  mockListThreads,
  mockAddMessage,
  mockGetOrCreateLatestThread,
  mockGetOrCreateFreshThread,
  mockGetLatestThread,
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
  mockScheduleTask: vi.fn(),
  mockUnscheduleTask: vi.fn(),
  mockGetAgent: vi.fn(),
  mockGetThread: vi.fn(),
  mockListThreads: vi.fn(),
  mockAddMessage: vi.fn(),
  mockGetOrCreateLatestThread: vi.fn(),
  mockGetOrCreateFreshThread: vi.fn(),
  mockGetLatestThread: vi.fn(),
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
    cronTask: {
      create: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
    },
    webhookSubscription: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
    },
    agentWorkspace: {
      update: vi.fn(),
    },
  },
}));

vi.mock('../services/heartbeat.service', () => ({
  heartbeatService: {
    startHeartbeat: mockStartHeartbeat,
    stopHeartbeat: mockStopHeartbeat,
    triggerHeartbeat: mockTriggerHeartbeat,
    getStatus: mockGetStatus,
  },
}));

vi.mock('../services/cron-scheduler.service', () => ({
  cronSchedulerService: {
    scheduleTask: mockScheduleTask,
    unscheduleTask: mockUnscheduleTask,
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
    getLatestThread: mockGetLatestThread,
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
    it('starts heartbeat and forces heartbeatStatus to ENABLED', async () => {
      const agent = {
        id: 'agent-1',
        userId: 'user-1',
        heartbeatIntervalMs: 60000,
        heartbeatStatus: 'STOPPED',
      };

      const res = await authedRequest(app)
        .post('/agents/heartbeat/start')
        .send({ agent });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Heartbeat started');
      // The /start endpoint's whole purpose is to turn the heartbeat on,
      // regardless of the body's persisted heartbeatStatus.
      expect(mockStartHeartbeat).toHaveBeenCalledWith({
        ...agent,
        heartbeatStatus: 'ENABLED',
      });
    });

    it('returns 400 when agent is missing from body', async () => {
      const res = await authedRequest(app)
        .post('/agents/heartbeat/start')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Missing agent in request body');
    });

    it('returns 500 when startHeartbeat throws', async () => {
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
      expect(mockStartHeartbeat).toHaveBeenCalledWith(updated);
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
  // POST /cron-tasks
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

  describe('POST /cron-tasks', () => {
    const persistedTask = {
      id: 'ct-1',
      agentId: 'agent-1',
      userId: 'user-1',
      name: 'Daily Report',
      schedule: '0 9 * * *',
      instruction: 'Generate report',
      isActive: true,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    };

    it('creates a cron task, persists it, schedules it, and returns the row', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', name: 'Agent' });
      mockPrisma.cronTask.create.mockResolvedValue(persistedTask);

      const res = await authedRequest(app)
        .post('/agents/cron-tasks')
        .send({ name: 'Daily Report', schedule: '0 9 * * *', instruction: 'Generate report' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('ct-1');
      expect(res.body.name).toBe('Daily Report');
      expect(mockPrisma.cronTask.create).toHaveBeenCalledWith({
        data: {
          agentId: 'agent-1',
          userId: 'user-1',
          name: 'Daily Report',
          schedule: '0 9 * * *',
          instruction: 'Generate report',
          nextRunAt: null,
        },
      });
      expect(mockScheduleTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ct-1', agentId: 'agent-1', userId: 'user-1' }),
      );
    });

    it('returns 400 when name is missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/cron-tasks')
        .send({ schedule: '0 9 * * *', instruction: 'x' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
      expect(mockPrisma.cronTask.create).not.toHaveBeenCalled();
    });

    it('returns 400 when schedule is missing', async () => {
      const res = await authedRequest(app)
        .post('/agents/cron-tasks')
        .send({ name: 'x', instruction: 'x' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('returns 500 when agent is missing', async () => {
      mockGetAgent.mockRejectedValue(new Error('Agent not found'));

      const res = await authedRequest(app)
        .post('/agents/cron-tasks')
        .send({ name: 'x', schedule: '0 9 * * *', instruction: 'x' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Agent not found');
      expect(mockPrisma.cronTask.create).not.toHaveBeenCalled();
    });

    it('returns 400 when the schedule is not a valid cron expression', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', name: 'Agent' });

      const res = await authedRequest(app)
        .post('/agents/cron-tasks')
        .send({ name: 'x', schedule: 'definitely not a cron', instruction: 'x' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid cron expression');
      expect(mockPrisma.cronTask.create).not.toHaveBeenCalled();
    });

    it('returns 500 when Prisma create throws', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', name: 'Agent' });
      mockPrisma.cronTask.create.mockRejectedValue(new Error('DB error'));

      const res = await authedRequest(app)
        .post('/agents/cron-tasks')
        .send({ name: 'x', schedule: '0 9 * * *', instruction: 'x' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  // ==========================================================================
  // DELETE /cron-tasks/:taskId
  // ==========================================================================

  describe('DELETE /cron-tasks/:taskId', () => {
    it('unschedules and deletes the task', async () => {
      mockPrisma.cronTask.delete.mockResolvedValue({ id: 'ct-1' });

      const res = await authedRequest(app)
        .delete('/agents/cron-tasks/ct-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockUnscheduleTask).toHaveBeenCalledWith('ct-1');
      expect(mockPrisma.cronTask.delete).toHaveBeenCalledWith({ where: { id: 'ct-1' } });
    });

    it('returns 404 when the task does not exist (Prisma P2025)', async () => {
      mockPrisma.cronTask.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Not found', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      const res = await authedRequest(app)
        .delete('/agents/cron-tasks/ct-missing');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Cron task not found');
      // No unschedule (and therefore no 'cron task deleted' event) for a
      // task that never existed.
      expect(mockUnscheduleTask).not.toHaveBeenCalled();
    });

    it('returns 500 when Prisma delete throws an unexpected error', async () => {
      mockPrisma.cronTask.delete.mockRejectedValue(new Error('Delete error'));

      const res = await authedRequest(app)
        .delete('/agents/cron-tasks/ct-1');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Delete error');
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
      expect(res.body).toEqual({ enabled: false });
    });

    it('flips the receiver flag on the agent row', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', webhooksEnabled: false });
      mockPrisma.agentWorkspace.update.mockResolvedValue({});

      const res = await authedRequest(app)
        .patch('/agents/webhooks/receiver')
        .send({ enabled: true });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ enabled: true });
      expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: { webhooksEnabled: true },
      });
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
        .send({ name: '  GitHub Push ', description: 'PR reviews' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(created);
      expect(mockPrisma.webhookSubscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          agentId: 'agent-1',
          name: 'github-push',
          description: 'PR reviews',
          deliverTo: 'all',
          deliverOnly: false,
        }),
      });
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

    it('409s duplicate names', async () => {
      mockPrisma.webhookSubscription.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const res = await authedRequest(app)
        .post('/agents/webhook-subscriptions')
        .send({ name: 'alerts' });

      expect(res.status).toBe(409);
      expect(res.body.fieldErrors.name).toContain('already taken');
    });
  });

  describe('PATCH /webhook-subscriptions/:id', () => {
    it('toggles isActive', async () => {
      const updated = { id: 'wh-1', isActive: false };
      mockPrisma.webhookSubscription.update.mockResolvedValue(updated);

      const res = await authedRequest(app)
        .patch('/agents/webhook-subscriptions/wh-1')
        .send({ isActive: false });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);
      expect(mockPrisma.webhookSubscription.update).toHaveBeenCalledWith({
        where: { id: 'wh-1' },
        data: { isActive: false },
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

    it('forwards threadSource=DATABASE to drop Slack / external threads', async () => {
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
      expect(mockGetThread).toHaveBeenCalledWith('user-1', 'agent-1', 'thread-1');
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
      expect(mockGetThread).toHaveBeenCalledWith('user-1', 'agent-1', 'thread-1');
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
        'user-1', 'agent-1', '1234.5678', { channelId: 'C123' }
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
      mockGetLatestThread.mockResolvedValue(null);
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
      mockGetLatestThread.mockResolvedValue({ id: 'latest', workspaceRoot: '/repo' });
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
