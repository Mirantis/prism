/**
 * Cron tools tests — schedule/update/delete delegation to cronSchedulerService.
 *
 * The 'cron task scheduled' / 'cron task updated' / 'cron task deleted' telemetry events are owned
 * by cronSchedulerService (see cron-scheduler.service.test.ts); the tools
 * must delegate and never emit them directly, or events would double up.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asSchema } from 'ai';
import * as nodeCron from 'node-cron';

const { mockPrisma, mockScheduler, mockTrackEvent } = vi.hoisted(() => ({
  mockPrisma: {
    cronTask: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  mockScheduler: {
    scheduleTask: vi.fn(),
    updateTask: vi.fn(),
    unscheduleTask: vi.fn(),
  },
  mockTrackEvent: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

// The scheduler imports `invoke`, which loads the tools and with them this module. Cut that chain
// so the module under test gets the mocked scheduler whatever loads first.
vi.mock('../../invoke', () => ({ invoke: vi.fn() }));

vi.mock('../../services/cron-scheduler.service', async () => {
  const actual = await vi.importActual<typeof import('../../services/cron-scheduler.service')>(
    '../../services/cron-scheduler.service',
  );
  return { toBackendCronTask: actual.toBackendCronTask, cronSchedulerService: mockScheduler };
});

vi.mock('../../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
}));

import { getCronTools } from '../cron';
import { parseSchedule } from '../../services/cron-schedule';

type ToolExecute = (input: Record<string, unknown>) => Promise<unknown>;

describe('cron tools', () => {
  let tools: Record<string, { execute: ToolExecute }>;

  beforeEach(() => {
    vi.clearAllMocks();
    tools = getCronTools('user-1', 'agent-1', 'heartbeat') as unknown as Record<string, { execute: ToolExecute }>;
  });

  it('schedule_task delegates to cronSchedulerService.scheduleTask and emits no telemetry itself', async () => {
    mockPrisma.cronTask.create.mockResolvedValue({
      id: 'task-1',
      agentId: 'agent-1',
      userId: 'user-1',
      name: 'Daily Report',
      schedule: '0 */2 * * *',
      instruction: 'report',
      isActive: true,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await tools.schedule_task.execute({
      name: 'Daily Report',
      schedule: 'every 2 hours',
      instruction: 'report',
    });

    // The mode goes to the scheduler, so its event tells an agent run's schedule from the user's.
    expect(mockScheduler.scheduleTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1', agentId: 'agent-1', userId: 'user-1' }),
      { invokeMode: 'heartbeat' },
    );
    // The scheduler owns the 'cron task scheduled' event — the tool must not
    // emit it too, or every schedule would be counted twice.
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('schedule_task rejects an invalid cron expression without scheduling', async () => {
    await expect(
      tools.schedule_task.execute({
        name: 'Broken',
        schedule: 'not a schedule',
        instruction: 'x',
      }),
    ).rejects.toThrow('Invalid cron expression');

    expect(mockScheduler.scheduleTask).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('delete_scheduled_task passes the userId to unscheduleTask and emits no telemetry itself', async () => {
    mockPrisma.cronTask.deleteMany.mockResolvedValue({ count: 1 });

    await tools.delete_scheduled_task.execute({ taskId: 'task-1' });

    expect(mockScheduler.unscheduleTask).toHaveBeenCalledWith('task-1', 'user-1', 'heartbeat');
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('update_scheduled_task edits the owner\'s task in the run\'s mode', async () => {
    mockScheduler.updateTask.mockResolvedValue({
      status: 'updated',
      task: { id: 'task-1', name: 'Daily Report', schedule: '0 9 * * *', nextRunAt: null },
    });

    const result = await tools.update_scheduled_task.execute({ taskId: 'task-1', schedule: 'every day at 9am' });

    expect(mockScheduler.updateTask).toHaveBeenCalledWith(
      'task-1',
      { schedule: 'every day at 9am' },
      { owner: { userId: 'user-1', agentId: 'agent-1' }, invokeMode: 'heartbeat' },
    );
    expect(result).toMatchObject({ success: true, taskId: 'task-1', schedule: '0 9 * * *', nextRunAt: null });
    // The scheduler owns the 'cron task updated' event.
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('update_scheduled_task returns a refused edit as an error', async () => {
    mockScheduler.updateTask.mockResolvedValue({ status: 'not_found', error: 'Cron task not found' });

    const result = await tools.update_scheduled_task.execute({ taskId: 'task-of-someone-else', name: 'Mine now' });

    expect(result).toEqual({ success: false, error: 'Cron task not found' });
  });

  it('keeps every schedule tool to the owning user and agent', async () => {
    mockPrisma.cronTask.create.mockResolvedValue({
      id: 'task-2',
      name: 'Recheck',
      schedule: 'in 5 minutes',
      instruction: 'x',
      isActive: true,
      nextRunAt: new Date(),
      lastRunAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockPrisma.cronTask.findMany.mockResolvedValue([]);
    mockPrisma.cronTask.deleteMany.mockResolvedValue({ count: 0 });

    await tools.schedule_task.execute({ name: 'Recheck', schedule: 'in 5 minutes', instruction: 'x' });
    await tools.list_scheduled_tasks.execute({});
    await tools.delete_scheduled_task.execute({ taskId: 'task-of-someone-else' });

    expect(mockPrisma.cronTask.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', agentId: 'agent-1' }),
    });
    expect(mockPrisma.cronTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', agentId: 'agent-1' } }),
    );
    expect(mockPrisma.cronTask.deleteMany).toHaveBeenCalledWith({
      where: { id: 'task-of-someone-else', userId: 'user-1', agentId: 'agent-1' },
    });
  });

  it('delete_scheduled_task does not unschedule (or emit) when no row was deleted', async () => {
    mockPrisma.cronTask.deleteMany.mockResolvedValue({ count: 0 });

    await tools.delete_scheduled_task.execute({ taskId: 'task-missing' });

    expect(mockScheduler.unscheduleTask).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // continueInThread ("wait & resume here")
  // --------------------------------------------------------------------------

  describe('continueInThread', () => {
    /** Tools pre-bound to a Slack thread, as a chat turn from a channel would be. */
    function boundTools() {
      return getCronTools('user-1', 'agent-1', 'chat', 'thread-9', 'slack', 'C123') as unknown as Record<
        string,
        { execute: ToolExecute }
      >;
    }

    it('binds a one-off task to the originating thread + channel and schedules it', async () => {
      mockPrisma.cronTask.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'wait-1',
          name: data.name,
          schedule: data.schedule,
          instruction: data.instruction,
          isActive: true,
          nextRunAt: new Date('2025-01-15T12:05:00Z'),
          lastRunAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          threadId: data.threadId ?? null,
          originChannel: data.originChannel ?? null,
          originChannelId: data.originChannelId ?? null,
        }),
      );

      const result = (await boundTools().schedule_task.execute({
        name: 'Recheck deploy',
        schedule: 'in 5 minutes',
        instruction: 'Check the deploy again.',
        continueInThread: true,
      })) as { success: boolean; continueInThread?: boolean };

      expect(result.success).toBe(true);
      expect(result.continueInThread).toBe(true);
      expect(mockPrisma.cronTask.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          threadId: 'thread-9',
          originChannel: 'slack',
          originChannelId: 'C123',
        }),
      });
      expect(mockScheduler.scheduleTask).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-9', originChannel: 'slack', originChannelId: 'C123' }),
        { invokeMode: 'chat' },
      );
    });

    it('rejects continueInThread on a recurring schedule without creating a task', async () => {
      const result = (await boundTools().schedule_task.execute({
        name: 'Loop',
        schedule: 'every 2 hours',
        instruction: 'x',
        continueInThread: true,
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/one-off/i);
      expect(mockPrisma.cronTask.create).not.toHaveBeenCalled();
      expect(mockScheduler.scheduleTask).not.toHaveBeenCalled();
    });

    it('rejects continueInThread when there is no thread to resume in', async () => {
      // Default `tools` is built without a threadId (autonomous/subagent-style).
      const result = (await tools.schedule_task.execute({
        name: 'Recheck',
        schedule: 'in 5 minutes',
        instruction: 'x',
        continueInThread: true,
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/thread/i);
      expect(mockPrisma.cronTask.create).not.toHaveBeenCalled();
    });

    it('leaves an ordinary (unbound) one-off task with no thread binding', async () => {
      mockPrisma.cronTask.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'task-2',
          name: data.name,
          schedule: data.schedule,
          instruction: data.instruction,
          isActive: true,
          nextRunAt: new Date('2025-01-15T12:05:00Z'),
          lastRunAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          threadId: null,
          originChannel: null,
          originChannelId: null,
        }),
      );

      await boundTools().schedule_task.execute({
        name: 'One-off',
        schedule: 'in 5 minutes',
        instruction: 'do it',
      });

      // No continueInThread → no binding fields persisted.
      const createArg = mockPrisma.cronTask.create.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(createArg.data.threadId).toBeUndefined();
      expect(createArg.data.originChannel).toBeUndefined();
    });
  });
});

describe('schedule examples', () => {
  // The model copies the schedule examples from the parameter description, so every one
  // of them has to be a schedule the tool accepts. "every hour" was offered and rejected.
  it.each(['schedule_task', 'update_scheduled_task'])(
    'accepts every schedule that the %s description offers as an example',
    async (name) => {
      const tools = getCronTools('user-1', 'agent-1', 'chat') as Record<string, { inputSchema: Parameters<typeof asSchema>[0] }>;
      const schema = (await asSchema(tools[name].inputSchema).jsonSchema) as {
        properties: { schedule: { description: string } };
      };
      const examples = [...schema.properties.schedule.description.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

      expect(examples).toContain('every hour');
      for (const example of examples) {
        const { isOneShot, cronExpression, nextRunAt } = parseSchedule(example);
        expect(isOneShot ? nextRunAt !== null : nodeCron.validate(cronExpression), example).toBe(true);
      }
    },
  );
});
