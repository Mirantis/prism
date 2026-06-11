/**
 * Cron tools tests — schedule/delete delegation to cronSchedulerService.
 *
 * The 'cron task scheduled' / 'cron task deleted' telemetry events are owned
 * by cronSchedulerService (see cron-scheduler.service.test.ts); the tools
 * must delegate and never emit them directly, or events would double up.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    unscheduleTask: vi.fn(),
  },
  mockTrackEvent: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

vi.mock('../../services/cron-scheduler.service', () => ({
  cronSchedulerService: mockScheduler,
}));

vi.mock('../../lib/telemetry', () => ({
  trackEvent: mockTrackEvent,
}));

import { getCronTools } from '../cron';

type ToolExecute = (input: Record<string, unknown>) => Promise<unknown>;

describe('cron tools', () => {
  let tools: Record<string, { execute: ToolExecute }>;

  beforeEach(() => {
    vi.clearAllMocks();
    tools = getCronTools('user-1', 'agent-1') as unknown as Record<string, { execute: ToolExecute }>;
  });

  it('schedule_task delegates to cronSchedulerService.scheduleTask and emits no telemetry itself', async () => {
    mockPrisma.cronTask.create.mockResolvedValue({
      id: 'task-1',
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

    expect(mockScheduler.scheduleTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1', agentId: 'agent-1', userId: 'user-1' }),
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

    expect(mockScheduler.unscheduleTask).toHaveBeenCalledWith('task-1', 'user-1');
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('delete_scheduled_task does not unschedule (or emit) when no row was deleted', async () => {
    mockPrisma.cronTask.deleteMany.mockResolvedValue({ count: 0 });

    await tools.delete_scheduled_task.execute({ taskId: 'task-missing' });

    expect(mockScheduler.unscheduleTask).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});
