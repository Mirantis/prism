/**
 * Scheduled Task Route Tests
 *
 * /agents/cron-tasks: what each write persists, what it hands the scheduler,
 * and how a refused body or a missing task is answered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockScheduleTask, mockUnscheduleTask, mockNextRunFor, mockGetAgent, mockPrisma } = vi.hoisted(() => ({
  mockScheduleTask: vi.fn(),
  mockUnscheduleTask: vi.fn(),
  mockNextRunFor: vi.fn(),
  mockGetAgent: vi.fn(),
  mockPrisma: {
    cronTask: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../lib/prisma', () => ({ prisma: mockPrisma, default: mockPrisma }));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// The scheduler runs a task through `invoke`, which no test here needs.
vi.mock('../invoke', () => ({ invoke: vi.fn() }));

vi.mock('../services/agent-workspace.service', () => ({
  agentWorkspaceService: { getAgent: mockGetAgent },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { cronTasksRouter } from './cron-tasks';
import { cronSchedulerService } from '../services/cron-scheduler.service';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/agents', cronTasksRouter);
  return app;
}

describe('Scheduled task routes', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    // The real edit, so a test sees what an edit writes and the task exactly as the scheduler
    // receives it. The jobs themselves are mocks.
    vi.spyOn(cronSchedulerService, 'scheduleTask').mockImplementation(mockScheduleTask);
    vi.spyOn(cronSchedulerService, 'unscheduleTask').mockImplementation(mockUnscheduleTask);
    vi.spyOn(cronSchedulerService, 'nextRunFor').mockImplementation(mockNextRunFor);
    app = createTestApp();
  });

  // ==========================================================================
  // GET /cron-tasks
  // ==========================================================================

  describe('GET /cron-tasks', () => {
    it('reads a recurring task’s next run from the scheduler and keeps a one-shot’s stored one', async () => {
      // The stored next run of a recurring task is what a boot reads. While a run
      // is in flight past its tick it lags behind the job.
      const recurring = {
        id: 'ct-rec',
        agentId: 'agent-1',
        userId: 'user-1',
        name: 'Morning brief',
        schedule: '0 9 * * 1-5',
        instruction: 'Brief me.',
        isActive: true,
        nextRunAt: new Date('2025-01-15T09:00:00Z'),
        lastRunAt: null,
        createdAt: new Date('2025-01-01T00:00:00Z'),
        updatedAt: new Date('2025-01-01T00:00:00Z'),
      };
      const once = { ...recurring, id: 'ct-once', schedule: 'in 10 minutes', nextRunAt: new Date('2025-01-15T12:10:00Z') };
      mockPrisma.cronTask.findMany.mockResolvedValue([recurring, once]);
      mockNextRunFor.mockImplementation((id: string) =>
        id === 'ct-rec' ? new Date('2025-01-16T09:00:00Z') : null,
      );

      const res = await request(app).get('/agents/cron-tasks');

      expect(res.status).toBe(200);
      expect(res.body[0].recurring).toBe(true);
      expect(res.body[0].nextRunAt).toBe('2025-01-16T09:00:00.000Z');
      expect(res.body[1].recurring).toBe(false);
      expect(res.body[1].nextRunAt).toBe('2025-01-15T12:10:00.000Z');
      expect(mockNextRunFor).toHaveBeenCalledWith('ct-rec');
      expect(mockNextRunFor).not.toHaveBeenCalledWith('ct-once');
    });

    it('reports no next run for a recurring task the scheduler does not hold', async () => {
      mockPrisma.cronTask.findMany.mockResolvedValue([
        {
          id: 'ct-paused',
          agentId: 'agent-1',
          userId: 'user-1',
          name: 'Paused',
          schedule: '0 * * * *',
          instruction: 'Warm the cache.',
          isActive: false,
          nextRunAt: new Date('2025-01-15T09:00:00Z'),
          lastRunAt: null,
          createdAt: new Date('2025-01-01T00:00:00Z'),
          updatedAt: new Date('2025-01-01T00:00:00Z'),
        },
      ]);
      mockNextRunFor.mockReturnValue(null);

      const res = await request(app).get('/agents/cron-tasks');

      expect(res.status).toBe(200);
      expect(res.body[0].recurring).toBe(true);
      expect(res.body[0].nextRunAt).toBeNull();
    });
  });

  // ==========================================================================
  // POST /cron-tasks
  // ==========================================================================

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
      deliverTo: 'all',
      channelIds: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    };

    it('creates a cron task, persists it, schedules it, and returns the row', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', name: 'Agent' });
      mockPrisma.cronTask.create.mockResolvedValue(persistedTask);

      const res = await request(app)
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
          deliverTo: 'all',
          channelIds: null,
        },
      });
      expect(mockScheduleTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ct-1', agentId: 'agent-1', userId: 'user-1' }),
      );
    });

    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post('/agents/cron-tasks')
        .send({ schedule: '0 9 * * *', instruction: 'x' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
      expect(mockPrisma.cronTask.create).not.toHaveBeenCalled();
    });

    it('returns 400 when the name is only whitespace', async () => {
      const res = await request(app)
        .post('/agents/cron-tasks')
        .send({ name: '   ', schedule: '0 9 * * *' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
      expect(mockPrisma.cronTask.create).not.toHaveBeenCalled();
    });

    it('stores the fields trimmed, and an omitted instruction as empty', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', name: 'Agent' });
      mockPrisma.cronTask.create.mockResolvedValue(persistedTask);

      await request(app)
        .post('/agents/cron-tasks')
        .send({ name: '  Daily Report  ', schedule: ' 0 9 * * * ' });

      expect(mockPrisma.cronTask.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: 'Daily Report', schedule: '0 9 * * *', instruction: '' }),
      });
    });

    it('returns 400 when schedule is missing', async () => {
      const res = await request(app)
        .post('/agents/cron-tasks')
        .send({ name: 'x', instruction: 'x' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required fields');
    });

    it('returns 500 when agent is missing', async () => {
      mockGetAgent.mockRejectedValue(new Error('Agent not found'));

      const res = await request(app)
        .post('/agents/cron-tasks')
        .send({ name: 'x', schedule: '0 9 * * *', instruction: 'x' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Agent not found');
      expect(mockPrisma.cronTask.create).not.toHaveBeenCalled();
    });

    it('returns 400 when the schedule is not a valid cron expression', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', name: 'Agent' });

      const res = await request(app)
        .post('/agents/cron-tasks')
        .send({ name: 'x', schedule: 'definitely not a cron', instruction: 'x' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid cron expression');
      expect(res.body.fieldErrors).toEqual({ schedule: res.body.error });
      expect(mockPrisma.cronTask.create).not.toHaveBeenCalled();
    });

    it('returns 500 when Prisma create throws', async () => {
      mockGetAgent.mockResolvedValue({ id: 'agent-1', userId: 'user-1', name: 'Agent' });
      mockPrisma.cronTask.create.mockRejectedValue(new Error('DB error'));

      const res = await request(app)
        .post('/agents/cron-tasks')
        .send({ name: 'x', schedule: '0 9 * * *', instruction: 'x' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('DB error');
    });
  });

  // ==========================================================================
  // PATCH /cron-tasks/:taskId
  // ==========================================================================

  describe('PATCH /cron-tasks/:taskId', () => {
    const recurring = {
      id: 'ct-1',
      agentId: 'agent-1',
      userId: 'user-1',
      name: 'Daily Report',
      schedule: '0 9 * * *',
      instruction: 'Generate report',
      isActive: true,
      nextRunAt: null,
      lastRunAt: null,
      threadId: null,
      originChannel: null,
      originChannelId: null,
      deliverTo: 'all',
      channelIds: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    };
    const oneShot = () => ({
      ...recurring,
      id: 'ct-once',
      schedule: 'in 10 minutes',
      nextRunAt: new Date(Date.now() + 10 * 60_000),
    });

    /** Answer the write with the stored row and the data it was given. */
    function echoUpdate(stored: object) {
      mockPrisma.cronTask.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          ...stored,
          ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
        }),
      );
    }

    it('saves the edited fields, re-registers the task as an update, and returns it as listed', async () => {
      mockPrisma.cronTask.findFirst.mockResolvedValue(recurring);
      echoUpdate(recurring);
      mockNextRunFor.mockReturnValue(new Date('2025-01-02T10:00:00Z'));

      const res = await request(app)
        .patch('/agents/cron-tasks/ct-1')
        .send({ name: '  Weekday Report ', schedule: '0 10 * * 1-5', instruction: 'Summarize the day' });

      expect(res.status).toBe(200);
      expect(mockPrisma.cronTask.findFirst).toHaveBeenCalledWith({ where: { id: 'ct-1' } });
      expect(mockPrisma.cronTask.update).toHaveBeenCalledWith({
        where: { id: 'ct-1' },
        data: {
          name: 'Weekday Report',
          schedule: '0 10 * * 1-5',
          instruction: 'Summarize the day',
          nextRunAt: null,
          deliverTo: 'all',
          channelIds: null,
        },
      });
      expect(mockScheduleTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ct-1', name: 'Weekday Report', schedule: '0 10 * * 1-5' }),
        { source: 'update' },
      );
      expect(res.body).toMatchObject({
        name: 'Weekday Report',
        recurring: true,
        nextRunAt: '2025-01-02T10:00:00.000Z',
      });
    });

    it('keeps the fields the body leaves out', async () => {
      mockPrisma.cronTask.findFirst.mockResolvedValue(recurring);
      echoUpdate(recurring);

      await request(app).patch('/agents/cron-tasks/ct-1').send({ instruction: 'Only this' });

      expect(mockPrisma.cronTask.update).toHaveBeenCalledWith({
        where: { id: 'ct-1' },
        data: {
          name: 'Daily Report',
          instruction: 'Only this',
          schedule: '0 9 * * *',
          nextRunAt: null,
          deliverTo: 'all',
          channelIds: null,
        },
      });
    });

    it('saves a new target and lists the chosen channels as an array', async () => {
      const stored = { ...recurring, deliverTo: 'slack', channelIds: 'C1' };
      mockPrisma.cronTask.findFirst.mockResolvedValue(stored);
      echoUpdate(stored);

      const res = await request(app).patch('/agents/cron-tasks/ct-1').send({ deliverTo: 'chat' });

      expect(res.status).toBe(200);
      expect(mockPrisma.cronTask.update).toHaveBeenCalledWith({
        where: { id: 'ct-1' },
        data: expect.objectContaining({ deliverTo: 'chat', channelIds: null }),
      });
      expect(res.body).toMatchObject({ deliverTo: 'chat', channelIds: [] });
    });

    it('refuses an unknown target on the deliverTo field', async () => {
      mockPrisma.cronTask.findFirst.mockResolvedValue(recurring);

      const res = await request(app).patch('/agents/cron-tasks/ct-1').send({ deliverTo: 'log' });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.deliverTo).toContain('deliverTo must be one of');
      expect(mockPrisma.cronTask.update).not.toHaveBeenCalled();
    });

    it('refuses a channel list that is not an array of ids', async () => {
      const res = await request(app).patch('/agents/cron-tasks/ct-1').send({ channelIds: 'C1' });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.channelIds).toBeDefined();
      expect(mockPrisma.cronTask.findFirst).not.toHaveBeenCalled();
    });

    it('keeps a one-shot’s run time when the body leaves its schedule out', async () => {
      const task = oneShot();
      mockPrisma.cronTask.findFirst.mockResolvedValue(task);
      echoUpdate(task);

      await request(app).patch('/agents/cron-tasks/ct-once').send({ instruction: 'Is it green?' });

      expect(mockScheduleTask).toHaveBeenCalledWith(
        expect.objectContaining({ instruction: 'Is it green?', nextRunAt: task.nextRunAt.toISOString() }),
        { source: 'update' },
      );
    });

    it('reads a one-shot schedule the body sends again from now', async () => {
      // "Snooze it another 10 minutes", four minutes before the old time.
      const task = { ...oneShot(), nextRunAt: new Date(Date.now() + 4 * 60_000) };
      mockPrisma.cronTask.findFirst.mockResolvedValue(task);
      echoUpdate(task);

      await request(app).patch('/agents/cron-tasks/ct-once').send({ schedule: 'in 10 minutes' });

      const { data } = mockPrisma.cronTask.update.mock.calls[0][0] as { data: { nextRunAt: Date } };
      expect(data.nextRunAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    });

    it('writes nothing and re-registers nothing for an edit that changes nothing', async () => {
      mockPrisma.cronTask.findFirst.mockResolvedValue(recurring);

      const res = await request(app)
        .patch('/agents/cron-tasks/ct-1')
        .send({ name: 'Daily Report', schedule: '0 9 * * *' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: 'ct-1', name: 'Daily Report' });
      expect(mockPrisma.cronTask.update).not.toHaveBeenCalled();
      expect(mockScheduleTask).not.toHaveBeenCalled();
    });

    it('refuses a field that is not a string, and a body with no field to change', async () => {
      const notText = await request(app).patch('/agents/cron-tasks/ct-1').send({ name: 42, schedule: null });
      const empty = await request(app).patch('/agents/cron-tasks/ct-1').send({});

      expect(notText.status).toBe(400);
      expect(notText.body.fieldErrors).toEqual({ name: 'name must be a string' });
      expect(empty.status).toBe(400);
      expect(empty.body.error).toContain('Nothing to change');
      expect(mockPrisma.cronTask.findFirst).not.toHaveBeenCalled();
      expect(mockScheduleTask).not.toHaveBeenCalled();
    });

    it('reads a changed schedule as the create route does', async () => {
      mockPrisma.cronTask.findFirst.mockResolvedValue(oneShot());
      echoUpdate(oneShot());

      await request(app).patch('/agents/cron-tasks/ct-once').send({ schedule: 'every day at 9am' });

      expect(mockPrisma.cronTask.update).toHaveBeenCalledWith({
        where: { id: 'ct-once' },
        data: expect.objectContaining({ schedule: '0 9 * * *', nextRunAt: null }),
      });
    });

    it('refuses an invalid cron expression on the schedule field', async () => {
      mockPrisma.cronTask.findFirst.mockResolvedValue(recurring);

      const res = await request(app)
        .patch('/agents/cron-tasks/ct-1')
        .send({ schedule: 'definitely not a cron' });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.schedule).toContain('Invalid cron expression');
      expect(mockPrisma.cronTask.update).not.toHaveBeenCalled();
      expect(mockScheduleTask).not.toHaveBeenCalled();
    });

    it('refuses an empty name or schedule', async () => {
      const noName = await request(app).patch('/agents/cron-tasks/ct-1').send({ name: '   ' });
      const noSchedule = await request(app).patch('/agents/cron-tasks/ct-1').send({ schedule: '' });

      expect(noName.status).toBe(400);
      expect(noName.body.fieldErrors).toEqual({ name: 'Name is required' });
      expect(noSchedule.status).toBe(400);
      expect(noSchedule.body.fieldErrors).toEqual({ schedule: 'Schedule is required' });
      expect(mockPrisma.cronTask.update).not.toHaveBeenCalled();
    });

    it('refuses a recurring schedule for a task that continues a conversation', async () => {
      mockPrisma.cronTask.findFirst.mockResolvedValue({
        ...oneShot(),
        threadId: 'thread-1',
        originChannel: 'websocket',
      });

      const res = await request(app).patch('/agents/cron-tasks/ct-once').send({ schedule: '0 * * * *' });

      expect(res.status).toBe(400);
      expect(res.body.fieldErrors.schedule).toContain('continues a conversation');
      expect(mockPrisma.cronTask.update).not.toHaveBeenCalled();
    });

    it('answers 409 for a one-shot that is running', async () => {
      const error = 'This task is running now, and it is removed when the run ends';
      vi.spyOn(cronSchedulerService, 'updateTask').mockResolvedValueOnce({ status: 'running', error });

      const res = await request(app).patch('/agents/cron-tasks/ct-once').send({ instruction: 'Too late' });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error });
    });

    it('returns 404 for a task that does not exist', async () => {
      mockPrisma.cronTask.findFirst.mockResolvedValue(null);

      const res = await request(app).patch('/agents/cron-tasks/ct-missing').send({ name: 'x' });

      expect(res.status).toBe(404);
      expect(mockScheduleTask).not.toHaveBeenCalled();
    });

    it('returns 404 when the task is deleted between the read and the write', async () => {
      mockPrisma.cronTask.findFirst.mockResolvedValue(recurring);
      mockPrisma.cronTask.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Not found', { code: 'P2025', clientVersion: 'test' }),
      );

      const res = await request(app).patch('/agents/cron-tasks/ct-1').send({ name: 'x' });

      expect(res.status).toBe(404);
      expect(mockScheduleTask).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // DELETE /cron-tasks/:taskId
  // ==========================================================================

  describe('DELETE /cron-tasks/:taskId', () => {
    it('unschedules and deletes the task', async () => {
      mockPrisma.cronTask.delete.mockResolvedValue({ id: 'ct-1' });

      const res = await request(app)
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

      const res = await request(app)
        .delete('/agents/cron-tasks/ct-missing');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Cron task not found');
      // No unschedule (and therefore no 'cron task deleted' event) for a
      // task that never existed.
      expect(mockUnscheduleTask).not.toHaveBeenCalled();
    });

    it('returns 500 when Prisma delete throws an unexpected error', async () => {
      mockPrisma.cronTask.delete.mockRejectedValue(new Error('Delete error'));

      const res = await request(app)
        .delete('/agents/cron-tasks/ct-1');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Delete error');
    });
  });
});
