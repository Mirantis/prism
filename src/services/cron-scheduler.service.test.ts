/**
 * Cron Scheduler Service Tests
 *
 * Tests for CronSchedulerService: scheduleTask (recurring + one-shot),
 * unscheduleTask, executeTask, stopAll.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockInvoke,
  mockDeliverMessage,
  mockCronTaskUpdate,
  mockCronTaskDelete,
  mockCronTaskFindMany,
  mockCronSchedule,
  mockCronValidate,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockDeliverMessage: vi.fn(),
  mockCronTaskUpdate: vi.fn(),
  mockCronTaskDelete: vi.fn(),
  mockCronTaskFindMany: vi.fn(),
  mockCronSchedule: vi.fn(),
  mockCronValidate: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('../invoke', () => ({
  invoke: mockInvoke,
}));

vi.mock('./message-delivery.service', () => ({
  messageDeliveryService: {
    publishToActiveThread: mockDeliverMessage,
  },
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    cronTask: {
      findMany: mockCronTaskFindMany,
      update: mockCronTaskUpdate,
      delete: mockCronTaskDelete,
    },
  },
}));

vi.mock('node-cron', () => ({
  schedule: mockCronSchedule,
  validate: mockCronValidate,
}));

const { mockTrackEvent } = vi.hoisted(() => ({ mockTrackEvent: vi.fn() }));

vi.mock('../lib/telemetry', () => ({
  trackEvent: mockTrackEvent,
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    error: mockLoggerError,
    warn: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { cronSchedulerService } from './cron-scheduler.service';
import type { BackendCronTask } from './cron-scheduler.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronTask(overrides: Partial<BackendCronTask> = {}): BackendCronTask {
  return {
    id: 'task-1',
    agentId: 'agent-1',
    userId: 'user-abc-123',
    name: 'Daily Report',
    schedule: '0 9 * * *',
    instruction: 'Generate the daily report.',
    isActive: true,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CronSchedulerService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));

    mockInvoke.mockResolvedValue({
      response: 'Task completed.',
      toolCalls: [{ tool: 'memory_write', input: '{}', output: 'ok', success: true, timestamp: '2025-01-15T12:00:00Z' }],
      steps: [{ text: 'Task completed.', toolCalls: [{ tool: 'memory_write', input: '{}', output: 'ok', success: true, timestamp: '2025-01-15T12:00:00Z' }] }],
    });
    mockDeliverMessage.mockResolvedValue({ messageId: 'msg-1', threadId: 'thr-1' });
    mockCronTaskUpdate.mockResolvedValue({});
    mockCronTaskDelete.mockResolvedValue({});
  });

  afterEach(() => {
    cronSchedulerService.stopAll();
    vi.useRealTimers();
  });

  // ==========================================================================
  // scheduleTask — recurring cron
  // ==========================================================================

  describe('scheduleTask (recurring cron)', () => {
    it('schedules a valid cron expression using node-cron', () => {
      const mockJob = { stop: vi.fn() };
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue(mockJob);

      const task = createCronTask({ schedule: '0 9 * * *' });
      cronSchedulerService.scheduleTask(task);

      expect(mockCronValidate).toHaveBeenCalledWith('0 9 * * *');
      expect(mockCronSchedule).toHaveBeenCalledWith('0 9 * * *', expect.any(Function));
    });

    it('does not schedule inactive tasks', () => {
      mockCronValidate.mockReturnValue(true);

      const task = createCronTask({ isActive: false });
      cronSchedulerService.scheduleTask(task);

      expect(mockCronSchedule).not.toHaveBeenCalled();
    });

    it('rejects invalid cron expressions', () => {
      mockCronValidate.mockReturnValue(false);

      const task = createCronTask({ schedule: 'not-a-cron', nextRunAt: null });
      cronSchedulerService.scheduleTask(task);

      expect(mockCronSchedule).not.toHaveBeenCalled();
    });

    it('unschedules existing task before rescheduling', () => {
      const mockJob1 = { stop: vi.fn() };
      const mockJob2 = { stop: vi.fn() };
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValueOnce(mockJob1).mockReturnValueOnce(mockJob2);

      const task = createCronTask();
      cronSchedulerService.scheduleTask(task);
      cronSchedulerService.scheduleTask(task);

      expect(mockJob1.stop).toHaveBeenCalled();
    });

    it('delivers only the final step text for multi-step results', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Checking...\n\nAll clear.',
        toolCalls: [{ tool: 'aws_costs', input: '{}', output: '0', success: true, timestamp: '2025-01-15T12:00:00Z' }],
        steps: [
          {
            text: 'Checking...',
            toolCalls: [{ tool: 'aws_costs', input: '{}', output: '0', success: true, timestamp: '2025-01-15T12:00:00Z' }],
          },
          {
            text: 'All clear.',
            toolCalls: [],
          },
        ],
      });

      let cronCallback: (() => Promise<void>) | undefined;
      const mockJob = { stop: vi.fn() };
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockImplementation((_schedule: string, cb: () => Promise<void>) => {
        cronCallback = cb;
        return mockJob;
      });

      cronSchedulerService.scheduleTask(createCronTask({ name: 'Cost Check' }));
      await cronCallback!();

      // Should deliver a single message with only the last step's text
      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);
      expect(mockDeliverMessage).toHaveBeenCalledWith(
        'agent-1',
        'user-abc-123',
        '**Scheduled Task: Cost Check**\n\nAll clear.',
        'CRON_TASK',
        expect.objectContaining({
          toolCalls: expect.arrayContaining([expect.objectContaining({ tool: 'aws_costs' })]),
        }),
      );
    });

    it('executes the task callback and invokes LLM', async () => {
      let cronCallback: (() => Promise<void>) | undefined;
      const mockJob = { stop: vi.fn() };
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockImplementation((_schedule: string, cb: () => Promise<void>) => {
        cronCallback = cb;
        return mockJob;
      });

      const task = createCronTask({ instruction: 'Check system health' });
      cronSchedulerService.scheduleTask(task);

      expect(cronCallback).toBeDefined();
      await cronCallback!();

      expect(mockInvoke).toHaveBeenCalledWith({
        userId: 'user-abc-123',
        agentId: 'agent-1',
        mode: 'cron',
        prompt: 'Check system health',
      });
      expect(mockCronTaskUpdate).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: { lastRunAt: expect.any(Date) },
      });
      expect(mockDeliverMessage).toHaveBeenCalledWith(
        'agent-1',
        'user-abc-123',
        expect.stringContaining('Daily Report'),
        'CRON_TASK',
        expect.objectContaining({ toolCalls: expect.any(Array) }),
      );
    });
  });

  // ==========================================================================
  // scheduleTask — one-shot
  // ==========================================================================

  describe('scheduleTask (one-shot)', () => {
    it('schedules a future one-shot task using setTimeout', () => {
      mockCronValidate.mockReturnValue(false); // not a valid cron expression

      const futureDate = new Date(Date.now() + 120_000).toISOString(); // 2 minutes ahead
      const task = createCronTask({
        id: 'oneshot-1',
        schedule: 'in 2 minutes',
        nextRunAt: futureDate,
      });

      cronSchedulerService.scheduleTask(task);

      // Should not use node-cron schedule
      expect(mockCronSchedule).not.toHaveBeenCalled();
    });

    it('executes one-shot task when timeout fires', async () => {
      mockCronValidate.mockReturnValue(false);

      const futureDate = new Date(Date.now() + 60_000).toISOString();
      const task = createCronTask({
        id: 'oneshot-2',
        schedule: 'in 1 minute',
        nextRunAt: futureDate,
      });

      cronSchedulerService.scheduleTask(task);

      // Advance past the delay
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockInvoke).toHaveBeenCalledWith({
        userId: 'user-abc-123',
        agentId: 'agent-1',
        mode: 'cron',
        prompt: 'Generate the daily report.',
      });
      expect(mockCronTaskDelete).toHaveBeenCalledWith({ where: { id: 'oneshot-2' } });
    });

    it('executes past-due one-shot task immediately via setImmediate', async () => {
      mockCronValidate.mockReturnValue(false);

      const pastDate = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
      const task = createCronTask({
        id: 'oneshot-past',
        schedule: 'at 11:59am',
        nextRunAt: pastDate,
      });

      cronSchedulerService.scheduleTask(task);

      // setImmediate schedules for next tick - advance timers to process it
      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke).toHaveBeenCalledWith({
        userId: 'user-abc-123',
        agentId: 'agent-1',
        mode: 'cron',
        prompt: 'Generate the daily report.',
      });
    });
  });

  // ==========================================================================
  // scheduleTask — validation
  // ==========================================================================

  describe('scheduleTask (validation)', () => {
    it('refuses to schedule a task with missing userId', () => {
      mockCronValidate.mockReturnValue(true);

      const task = createCronTask({ userId: undefined as unknown as string });
      cronSchedulerService.scheduleTask(task);

      expect(mockCronSchedule).not.toHaveBeenCalled();
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('missing userId'),
      );
    });
  });

  // ==========================================================================
  // unscheduleTask
  // ==========================================================================

  describe('unscheduleTask', () => {
    it('stops and removes a scheduled recurring task', () => {
      const mockJob = { stop: vi.fn() };
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue(mockJob);

      const task = createCronTask();
      cronSchedulerService.scheduleTask(task);
      cronSchedulerService.unscheduleTask('task-1');

      expect(mockJob.stop).toHaveBeenCalled();
    });

    it('is a no-op when task does not exist', () => {
      // Should not throw
      cronSchedulerService.unscheduleTask('non-existent');
    });
  });

  // ==========================================================================
  // executeTask error handling
  // ==========================================================================

  describe('executeTask error handling', () => {
    it('logs error and does not deliver on invoke failure', async () => {
      mockInvoke.mockRejectedValue(new Error('LLM timeout'));

      let cronCallback: (() => Promise<void>) | undefined;
      const mockJob = { stop: vi.fn() };
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockImplementation((_schedule: string, cb: () => Promise<void>) => {
        cronCallback = cb;
        return mockJob;
      });

      const task = createCronTask();
      cronSchedulerService.scheduleTask(task);
      await cronCallback!();

      expect(mockLoggerError).toHaveBeenCalled();
      // Should not deliver a message on error
      expect(mockDeliverMessage).not.toHaveBeenCalled();
    });

    it('handles delete failure for one-shot tasks gracefully', async () => {
      mockCronValidate.mockReturnValue(false);
      mockCronTaskDelete.mockRejectedValue(new Error('Delete failed'));

      const futureDate = new Date(Date.now() + 60_000).toISOString();
      const task = createCronTask({
        id: 'oneshot-del-fail',
        schedule: 'in 1 minute',
        nextRunAt: futureDate,
      });

      cronSchedulerService.scheduleTask(task);

      // Should not throw when deleteCronTask fails
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockInvoke).toHaveBeenCalled();
      expect(mockCronTaskDelete).toHaveBeenCalledWith({ where: { id: 'oneshot-del-fail' } });
    });
  });

  // ==========================================================================
  // Telemetry
  // ==========================================================================

  describe('telemetry', () => {
    /** Schedule a recurring task and return the captured cron callback. */
    function scheduleAndCapture(): () => Promise<void> {
      let cronCallback: (() => Promise<void>) | undefined;
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockImplementation((_schedule: string, cb: () => Promise<void>) => {
        cronCallback = cb;
        return { stop: vi.fn() };
      });
      cronSchedulerService.scheduleTask(createCronTask());
      return cronCallback!;
    }

    it('emits "cron task executed" with result=completed on success', async () => {
      const run = scheduleAndCapture();
      await run();

      expect(mockTrackEvent).toHaveBeenCalledWith('cron task executed', 'user-abc-123', {
        'agent.id': 'agent-1',
        'cron.task.id': 'task-1',
        'cron.task.name': 'Daily Report',
        'cron.result': 'completed',
        'cron.duration_ms': expect.any(String),
      });
    });

    it('emits "cron task executed" with result=budget_exceeded', async () => {
      mockInvoke.mockResolvedValue({
        response: '',
        toolCalls: [],
        steps: [],
        error: { type: 'budget_exceeded', detail: null },
      });

      const run = scheduleAndCapture();
      await run();

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'cron task executed',
        'user-abc-123',
        expect.objectContaining({ 'cron.result': 'budget_exceeded' }),
      );
    });

    it('emits "cron task executed" with result=error on invoke failure', async () => {
      mockInvoke.mockRejectedValue(new Error('LLM timeout'));

      const run = scheduleAndCapture();
      await run();

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'cron task executed',
        'user-abc-123',
        expect.objectContaining({ 'cron.result': 'error' }),
      );
    });

    it('emits "cron task scheduled" when a task is scheduled (single owner of the event)', () => {
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn() });

      cronSchedulerService.scheduleTask(createCronTask());

      expect(mockTrackEvent).toHaveBeenCalledWith('cron task scheduled', 'user-abc-123', {
        'agent.id': 'agent-1',
        'cron.task.id': 'task-1',
        'cron.task.name': 'Daily Report',
        'cron.schedule': '0 9 * * *',
        'cron.one_shot': 'false',
      });
    });

    it('does not emit "cron task scheduled" for boot re-registrations', () => {
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn() });

      cronSchedulerService.scheduleTask(createCronTask(), { source: 'boot' });

      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('emits "cron task deleted" on unscheduleTask, but not on internal re-registration', () => {
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn() });

      // Re-registering the same task replaces the job via the private
      // stopJob path — no delete event.
      cronSchedulerService.scheduleTask(createCronTask(), { source: 'boot' });
      cronSchedulerService.scheduleTask(createCronTask(), { source: 'boot' });
      expect(mockTrackEvent).not.toHaveBeenCalled();

      cronSchedulerService.unscheduleTask('task-1', 'user-abc-123');

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'cron task deleted',
        'user-abc-123',
        expect.objectContaining({ 'cron.task.id': 'task-1' }),
      );
    });
  });

  // ==========================================================================
  // stopAll
  // ==========================================================================

  describe('stopAll', () => {
    it('stops all scheduled cron jobs', () => {
      const mockJob1 = { stop: vi.fn() };
      const mockJob2 = { stop: vi.fn() };
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule
        .mockReturnValueOnce(mockJob1)
        .mockReturnValueOnce(mockJob2);

      cronSchedulerService.scheduleTask(createCronTask({ id: 'task-1' }));
      cronSchedulerService.scheduleTask(createCronTask({ id: 'task-2' }));
      cronSchedulerService.stopAll();

      expect(mockJob1.stop).toHaveBeenCalled();
      expect(mockJob2.stop).toHaveBeenCalled();
    });

    it('clears the internal jobs map', () => {
      const mockJob = { stop: vi.fn() };
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue(mockJob);

      cronSchedulerService.scheduleTask(createCronTask());
      cronSchedulerService.stopAll();

      // unscheduleTask should be no-op after stopAll since map is cleared
      cronSchedulerService.unscheduleTask('task-1');
      // If map was not cleared, stop would have been called again
      expect(mockJob.stop).toHaveBeenCalledTimes(1);
    });

    it('is safe to call when no tasks are scheduled', () => {
      // Should not throw
      cronSchedulerService.stopAll();
    });
  });
});
