/**
 * Cron Scheduler Service Tests
 *
 * Tests for CronSchedulerService: scheduleTask (recurring + one-shot),
 * unscheduleTask, executeTask, delivery gate suppression, stopAll.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockInvoke,
  mockDeliverMessage,
  mockPublish,
  mockThreadContext,
  mockThreadFindUnique,
  mockCronTaskUpdateMany,
  mockCronTaskDeleteMany,
  mockCronTaskFindMany,
  mockCronTaskFindFirst,
  mockCronTaskUpdate,
  mockCronSchedule,
  mockCronValidate,
  mockGenerateText,
  mockGetGateRequest,
  mockLoggerError,
  mockBeginWork,
  mockFinishWork,
  mockWritableThreadId,
  mockGetAdapter,
  mockGetOrCreateLatestThread,
  shutdown,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockDeliverMessage: vi.fn(),
  mockPublish: vi.fn(),
  mockThreadContext: vi.fn(),
  mockThreadFindUnique: vi.fn(),
  mockCronTaskUpdateMany: vi.fn(),
  mockCronTaskDeleteMany: vi.fn(),
  mockCronTaskFindMany: vi.fn(),
  mockCronTaskFindFirst: vi.fn(),
  mockCronTaskUpdate: vi.fn(),
  mockCronSchedule: vi.fn(),
  mockCronValidate: vi.fn(),
  mockGenerateText: vi.fn(),
  mockGetGateRequest: vi.fn(),
  mockLoggerError: vi.fn(),
  mockBeginWork: vi.fn(async () => undefined),
  mockFinishWork: vi.fn(),
  mockWritableThreadId: vi.fn(),
  mockGetAdapter: vi.fn(),
  mockGetOrCreateLatestThread: vi.fn(),
  shutdown: { controller: new AbortController() },
}));

vi.mock('../invoke', () => ({
  invoke: mockInvoke,
}));

vi.mock('./message-delivery.service', () => ({
  messageDeliveryService: {
    publishToLatestThread: mockDeliverMessage,
    publish: mockPublish,
    threadContext: mockThreadContext,
    getAdapter: mockGetAdapter,
  },
}));

vi.mock('./conversation.service', () => ({
  conversationService: {
    writableThreadId: mockWritableThreadId,
    getOrCreateLatestThread: mockGetOrCreateLatestThread,
  },
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    cronTask: {
      findMany: mockCronTaskFindMany,
      findFirst: mockCronTaskFindFirst,
      update: mockCronTaskUpdate,
      updateMany: mockCronTaskUpdateMany,
      deleteMany: mockCronTaskDeleteMany,
    },
    conversationThread: {
      findUnique: mockThreadFindUnique,
    },
  },
}));

vi.mock('./pending-work.service', () => ({
  MAX_RESUME_ATTEMPTS: 3,
  pendingWorkService: {
    get shutdownSignal() {
      return shutdown.controller.signal;
    },
    begin: mockBeginWork,
    finish: mockFinishWork,
  },
}));

vi.mock('node-cron', () => ({
  schedule: mockCronSchedule,
  validate: mockCronValidate,
}));

vi.mock('ai', () => ({
  generateText: mockGenerateText,
}));

vi.mock('../lib/classification', () => ({
  getGateRequest: mockGetGateRequest,
}));

const { mockTrackEvent } = vi.hoisted(() => ({ mockTrackEvent: vi.fn() }));

vi.mock('../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
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

import { cronSchedulerService, toBackendCronTask } from './cron-scheduler.service';
import type { BackendCronTask } from './cron-scheduler.service';
import type { CronTask } from '@prisma/client';

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
    threadId: null,
    originChannel: null,
    originChannelId: null,
    deliverTo: 'all',
    channelIds: null,
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
    mockPublish.mockResolvedValue({ id: 'msg-1', threadId: 'thr-1' });
    mockThreadContext.mockResolvedValue({ channel: 'websocket', threadId: 'thread-bound' });
    mockThreadFindUnique.mockResolvedValue({ id: 'thread-bound' });
    mockWritableThreadId.mockImplementation(async (threadId: string) => threadId);
    mockCronTaskUpdateMany.mockResolvedValue({ count: 1 });
    mockCronTaskDeleteMany.mockResolvedValue({ count: 1 });
    shutdown.controller = new AbortController();
    // Default: gate delivers (the suppression suite overrides this)
    mockGenerateText.mockResolvedValue({ text: 'DELIVER' });
    mockGetGateRequest.mockReturnValue({
      model: 'classification-model',
      providerOptions: {},
      samplingParams: { temperature: 0 },
    });
  });

  afterEach(() => {
    cronSchedulerService.stopAll();
    cronSchedulerService.useTimezone('UTC');
    vi.useRealTimers();
  });

  // ==========================================================================
  // scheduleTask — recurring cron
  // ==========================================================================

  describe('scheduleTask (recurring cron)', () => {
    it('reports the next run of a recurring task from its running job', () => {
      const next = new Date('2025-01-16T09:00:00Z');
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn(), getNextRun: () => next });

      cronSchedulerService.scheduleTask(createCronTask({ id: 'task-next' }));

      expect(cronSchedulerService.nextRunFor('task-next')).toEqual(next);
      expect(cronSchedulerService.nextRunFor('task-unknown')).toBeNull();
    });

    it('reports the stored time of a one-shot task', () => {
      mockCronValidate.mockReturnValue(false);

      cronSchedulerService.scheduleTask(
        createCronTask({ id: 'task-once', schedule: 'in 10 minutes', nextRunAt: '2025-01-15T12:10:00.000Z' }),
      );

      expect(cronSchedulerService.nextRunFor('task-once')).toEqual(new Date('2025-01-15T12:10:00.000Z'));
    });

    it('schedules a valid cron expression using node-cron', () => {
      const mockJob = { stop: vi.fn() };
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue(mockJob);

      const task = createCronTask({ schedule: '0 9 * * *' });
      cronSchedulerService.scheduleTask(task);

      expect(mockCronValidate).toHaveBeenCalledWith('0 9 * * *');
      expect(mockCronSchedule).toHaveBeenCalledWith('0 9 * * *', expect.any(Function), { timezone: 'UTC' });
    });

    it('reads recurring schedules in the agent’s time zone and replaces running jobs on a change', () => {
      const next = new Date('2025-01-16T07:00:00Z');
      const first = { stop: vi.fn() };
      const second = { stop: vi.fn(), getNextRun: () => next };
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValueOnce(first).mockReturnValueOnce(second);
      // The baseline the DELIVER/SUPPRESS gate compares against; the instruction is unchanged,
      // so a zone change must not make the next unchanged result read as new.
      const baselines = (cronSchedulerService as unknown as { lastDelivered: Map<string, unknown> }).lastDelivered;

      cronSchedulerService.scheduleTask(createCronTask({ id: 'task-tz', schedule: '0 9 * * *' }));
      baselines.set('task-tz', { text: 'Pods are fine.', at: Date.now() });
      cronSchedulerService.useTimezone('Europe/Helsinki');

      expect(first.stop).toHaveBeenCalled();
      expect(mockCronSchedule).toHaveBeenLastCalledWith('0 9 * * *', expect.any(Function), {
        timezone: 'Europe/Helsinki',
      });
      expect(cronSchedulerService.nextRunFor('task-tz')).toEqual(next);
      expect(baselines.has('task-tz')).toBe(true);
      // The replacement is not a new schedule.
      const scheduledEvents = mockTrackEvent.mock.calls.filter(([name]) => name === 'cron task scheduled');
      expect(scheduledEvents).toHaveLength(1);
    });

    it('uses UTC for a time zone name no date can be computed in', () => {
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn() });

      cronSchedulerService.useTimezone('Nope/Zone');
      cronSchedulerService.scheduleTask(createCronTask({ schedule: '0 9 * * *' }));

      expect(mockCronSchedule).toHaveBeenCalledWith('0 9 * * *', expect.any(Function), { timezone: 'UTC' });
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
        abortSignal: expect.any(AbortSignal),
      });
      expect(mockCronTaskUpdateMany).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: { nextRunAt: null, lastRunAt: expect.any(Date) },
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
  // A restart at any moment
  // ==========================================================================

  describe('a restart at any moment', () => {
    const tomorrow = new Date('2025-01-16T09:00:00Z');

    it('stores when a recurring task next runs', async () => {
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn(), getNextRun: () => tomorrow });

      cronSchedulerService.scheduleTask(createCronTask());
      await vi.advanceTimersByTimeAsync(0);

      expect(mockCronTaskUpdateMany).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: { nextRunAt: tomorrow },
      });
    });

    it('runs a recurring task at boot once when its stored run is due', async () => {
      // Its last run was interrupted, or its tick fell while the runtime was down.
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn(), getNextRun: () => tomorrow });

      cronSchedulerService.scheduleTask(
        createCronTask({ nextRunAt: '2025-01-15T09:00:00.000Z' }),
        { source: 'boot' },
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      // A run of the task may have stopped part-way at the restart, and the model is told.
      expect(mockInvoke).toHaveBeenCalledWith(expect.objectContaining({ afterRestart: true }));
      // The completed run, and nothing earlier, moves the stored time on.
      expect(mockCronTaskUpdateMany).toHaveBeenCalledTimes(1);
      expect(mockCronTaskUpdateMany).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: { nextRunAt: tomorrow, lastRunAt: expect.any(Date) },
      });
    });

    it('runs a task with no stored next run at boot when a tick fell after its last run', async () => {
      // Stored before next runs were stored: the last run was yesterday's 09:00,
      // and today's 09:00 fell while the runtime was down for the upgrade.
      const atNine = (date: Date) => date.getUTCHours() === 9 && date.getUTCMinutes() === 0;
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn(), getNextRun: () => tomorrow, match: atNine });

      cronSchedulerService.scheduleTask(
        createCronTask({ lastRunAt: '2025-01-14T09:00:00.000Z' }),
        { source: 'boot' },
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith(expect.objectContaining({ afterRestart: true }));
    });

    it('waits at boot for a task with no stored next run when no tick fell after its last run', async () => {
      const atNine = (date: Date) => date.getUTCHours() === 9 && date.getUTCMinutes() === 0;
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn(), getNextRun: () => tomorrow, match: atNine });

      cronSchedulerService.scheduleTask(
        createCronTask({ lastRunAt: '2025-01-15T09:00:00.000Z' }),
        { source: 'boot' },
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke).not.toHaveBeenCalled();
      // The boot stores the next run, so the next restart compares against it.
      expect(mockCronTaskUpdateMany).toHaveBeenCalledWith({ where: { id: 'task-1' }, data: { nextRunAt: tomorrow } });
    });

    it('waits for the tick at boot when the stored run is still ahead', async () => {
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn(), getNextRun: () => tomorrow });

      cronSchedulerService.scheduleTask(
        createCronTask({ nextRunAt: tomorrow.toISOString() }),
        { source: 'boot' },
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('leaves a run a shutdown stopped due, and delivers nothing', async () => {
      let cronCallback: (() => Promise<void>) | undefined;
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockImplementation((_schedule: string, cb: () => Promise<void>) => {
        cronCallback = cb;
        return { stop: vi.fn(), getNextRun: () => tomorrow };
      });
      mockInvoke.mockImplementation(async () => {
        shutdown.controller.abort();
        return { response: 'half done', toolCalls: [], steps: [{ text: 'half done', toolCalls: [] }] };
      });
      cronSchedulerService.scheduleTask(createCronTask());
      await vi.advanceTimersByTimeAsync(0);
      mockCronTaskUpdateMany.mockClear();

      await cronCallback!();

      expect(mockDeliverMessage).not.toHaveBeenCalled();
      expect(mockCronTaskUpdateMany).not.toHaveBeenCalled();
      // The row stays, so the next boot counts the run it starts again.
      expect(mockBeginWork).toHaveBeenCalledWith('cron', 'task-1', {});
      expect(mockFinishWork).not.toHaveBeenCalled();
    });

    it('keeps a run as pending work from before the model call until it is recorded', async () => {
      let cronCallback: (() => Promise<void>) | undefined;
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockImplementation((_schedule: string, cb: () => Promise<void>) => {
        cronCallback = cb;
        return { stop: vi.fn(), getNextRun: () => tomorrow };
      });
      cronSchedulerService.scheduleTask(createCronTask());
      await vi.advanceTimersByTimeAsync(0);
      mockCronTaskUpdateMany.mockClear();

      await cronCallback!();

      expect(mockBeginWork).toHaveBeenCalledWith('cron', 'task-1', {});
      expect(mockBeginWork.mock.invocationCallOrder[0]).toBeLessThan(mockInvoke.mock.invocationCallOrder[0]);
      expect(mockFinishWork).toHaveBeenCalledWith('cron', 'task-1');
      expect(mockCronTaskUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(mockFinishWork.mock.invocationCallOrder[0]);
    });

    it('skips a missed run at boot that stopped the runtime on every boot, and stores the next one', async () => {
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn(), getNextRun: () => tomorrow });
      await cronSchedulerService.resume([], [
        { key: 'task-1', payload: {}, attempts: 4, createdAt: new Date() },
      ]);

      cronSchedulerService.scheduleTask(
        createCronTask({ nextRunAt: '2025-01-15T09:00:00.000Z' }),
        { source: 'boot' },
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockCronTaskUpdateMany).toHaveBeenCalledWith({ where: { id: 'task-1' }, data: { nextRunAt: tomorrow } });
    });

    it('deletes a past-due one-shot at boot that stopped the runtime on every boot', async () => {
      mockCronValidate.mockReturnValue(false);
      await cronSchedulerService.resume([], [
        { key: 'oneshot-loop', payload: {}, attempts: 4, createdAt: new Date() },
      ]);

      cronSchedulerService.scheduleTask(
        createCronTask({ id: 'oneshot-loop', schedule: 'in 1 minute', nextRunAt: new Date(Date.now() - 60_000).toISOString() }),
        { source: 'boot' },
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockCronTaskDeleteMany).toHaveBeenCalledWith({ where: { id: 'oneshot-loop' } });
    });

    it('records a run whose result went out while the process shut down', async () => {
      // The model finished; the shutdown lands during the delivery, which the
      // result still reaches. The next boot must not run and deliver it again.
      let cronCallback: (() => Promise<void>) | undefined;
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockImplementation((_schedule: string, cb: () => Promise<void>) => {
        cronCallback = cb;
        return { stop: vi.fn(), getNextRun: () => tomorrow };
      });
      mockDeliverMessage.mockImplementationOnce(async () => {
        shutdown.controller.abort();
      });
      cronSchedulerService.scheduleTask(createCronTask());
      await vi.advanceTimersByTimeAsync(0);
      mockCronTaskUpdateMany.mockClear();

      await cronCallback!();

      expect(mockInvoke).toHaveBeenCalledWith(expect.objectContaining({ afterRestart: undefined }));
      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);
      expect(mockCronTaskUpdateMany).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: { nextRunAt: tomorrow, lastRunAt: expect.any(Date) },
      });
    });

    it('runs a one-shot that fell due during the downtime at boot, then deletes it', async () => {
      mockCronValidate.mockReturnValue(false);

      cronSchedulerService.scheduleTask(
        createCronTask({ id: 'oneshot-due', schedule: 'in 1 minute', nextRunAt: new Date(Date.now() - 60_000).toISOString() }),
        { source: 'boot' },
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke).toHaveBeenCalledWith(expect.objectContaining({ afterRestart: true }));
      expect(mockCronTaskDeleteMany).toHaveBeenCalledWith({ where: { id: 'oneshot-due' } });
    });

    it('keeps a one-shot a shutdown stopped, for the next boot to run', async () => {
      mockCronValidate.mockReturnValue(false);
      mockInvoke.mockImplementation(async () => {
        shutdown.controller.abort();
        return { response: '', toolCalls: [], steps: [] };
      });

      cronSchedulerService.scheduleTask(
        createCronTask({ id: 'oneshot-cut', schedule: 'in 1 minute', nextRunAt: new Date(Date.now() + 60_000).toISOString() }),
      );
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockCronTaskDeleteMany).not.toHaveBeenCalled();
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
        afterRestart: false,
        abortSignal: expect.any(AbortSignal),
      });
      expect(mockCronTaskDeleteMany).toHaveBeenCalledWith({ where: { id: 'oneshot-2' } });
    });

    it('delivers and logs no error when the run deleted its own task', async () => {
      mockCronValidate.mockReturnValue(false);
      const task = createCronTask({
        id: 'oneshot-self',
        schedule: 'in 1 minute',
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      });
      // What `delete_scheduled_task` does inside the run: the row goes, then the job.
      mockInvoke.mockImplementation(async () => {
        mockCronTaskUpdateMany.mockResolvedValue({ count: 0 });
        mockCronTaskDeleteMany.mockResolvedValue({ count: 0 });
        cronSchedulerService.unscheduleTask(task.id, task.userId);
        return { response: 'Done.', toolCalls: [], steps: [{ text: 'Done.', toolCalls: [] }] };
      });

      cronSchedulerService.scheduleTask(task);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockDeliverMessage).toHaveBeenCalledWith(
        'agent-1',
        'user-abc-123',
        '**Scheduled Task: Daily Report**\n\nDone.',
        'CRON_TASK',
        expect.anything(),
      );
      expect(mockCronTaskDeleteMany).toHaveBeenCalledWith({ where: { id: 'oneshot-self' } });
      expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it('executes a past-due one-shot task at once', async () => {
      mockCronValidate.mockReturnValue(false);

      const pastDate = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
      const task = createCronTask({
        id: 'oneshot-past',
        schedule: 'at 11:59am',
        nextRunAt: pastDate,
      });

      cronSchedulerService.scheduleTask(task);

      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke).toHaveBeenCalledWith({
        userId: 'user-abc-123',
        agentId: 'agent-1',
        mode: 'cron',
        prompt: 'Generate the daily report.',
        afterRestart: false,
        abortSignal: expect.any(AbortSignal),
      });
    });
  });

  // ==========================================================================
  // updateTask — an edit against the task's running job
  // ==========================================================================

  describe('updateTask', () => {
    /** A stored row, as Prisma returns it. */
    function storedRow(overrides: Partial<CronTask> = {}): CronTask {
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
        threadId: null,
        originChannel: null,
        originChannelId: null,
        deliverTo: 'all',
        channelIds: null,
        createdAt: new Date('2025-01-01T00:00:00Z'),
        updatedAt: new Date('2025-01-01T00:00:00Z'),
        ...overrides,
      };
    }

    const done = { response: 'Done.', toolCalls: [], steps: [{ text: 'Done.', toolCalls: [] }] };

    beforeEach(() => {
      // A one-shot keeps the words it was asked in, which are no cron expression.
      mockCronValidate.mockImplementation((schedule: string) => !schedule.startsWith('in '));
      mockCronSchedule.mockReturnValue({ stop: vi.fn(), getNextRun: () => null });
      mockCronTaskUpdate.mockImplementation(({ where, data }: { where: { id: string }; data: Partial<CronTask> }) =>
        Promise.resolve(storedRow({ id: where.id, ...data })),
      );
    });

    it('runs the edited one-shot, and not the old one, when its time comes during the edit', async () => {
      const row = storedRow({ id: 'once', schedule: 'in 1 minutes', nextRunAt: new Date(Date.now() + 100) });
      cronSchedulerService.scheduleTask(toBackendCronTask(row));
      mockCronTaskFindFirst.mockResolvedValue(row);
      let finishWrite!: () => void;
      mockCronTaskUpdate.mockImplementationOnce(
        ({ data }: { data: Partial<CronTask> }) =>
          new Promise((resolve) => {
            finishWrite = () => resolve({ ...row, ...data });
          }),
      );

      const edit = cronSchedulerService.updateTask('once', { instruction: 'The new instruction.' });
      await vi.advanceTimersByTimeAsync(0);
      expect(mockCronTaskUpdate).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100); // the old timer fires while the write is in flight
      finishWrite();
      await expect(edit).resolves.toMatchObject({ status: 'updated' });
      await vi.advanceTimersByTimeAsync(10);

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'The new instruction.' }));
      expect(mockCronTaskDeleteMany).toHaveBeenCalledTimes(1);
    });

    it('refuses an edit while a one-shot runs, and deletes the task when the run ends', async () => {
      const row = storedRow({ id: 'once', schedule: 'in 1 minutes', nextRunAt: new Date(Date.now() + 60_000) });
      cronSchedulerService.scheduleTask(toBackendCronTask(row));
      let finishRun!: (result: unknown) => void;
      mockInvoke.mockImplementationOnce(() => new Promise((resolve) => (finishRun = resolve)));
      await vi.advanceTimersByTimeAsync(60_000);
      mockCronTaskFindFirst.mockResolvedValue(row);

      const edit = await cronSchedulerService.updateTask('once', { instruction: 'Too late.' });

      expect(edit).toEqual({ status: 'running', error: expect.stringContaining('running now') });
      expect(mockCronTaskUpdate).not.toHaveBeenCalled();
      finishRun(done);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockCronTaskDeleteMany).toHaveBeenCalledWith({ where: { id: 'once' } });
    });

    it('runs a task edited into a one-shot during a run of its old schedule once that run ends', async () => {
      let tick!: () => Promise<void>;
      mockCronSchedule.mockImplementation((_schedule: string, cb: () => Promise<void>) => {
        tick = cb;
        return { stop: vi.fn(), getNextRun: () => null };
      });
      const row = storedRow();
      cronSchedulerService.scheduleTask(toBackendCronTask(row));
      let finishRun!: (result: unknown) => void;
      mockInvoke.mockImplementationOnce(() => new Promise((resolve) => (finishRun = resolve)));
      const recurringRun = tick();
      mockCronTaskFindFirst.mockResolvedValue(row);

      await cronSchedulerService.updateTask('task-1', { schedule: 'in 1 minutes', instruction: 'Check once more.' });
      await vi.advanceTimersByTimeAsync(60_000); // the one-shot's time comes during the old run

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockCronTaskDeleteMany).not.toHaveBeenCalled();
      finishRun(done);
      await recurringRun;
      await vi.advanceTimersByTimeAsync(0);
      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(mockInvoke).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'Check once more.' }));
      expect(mockCronTaskDeleteMany).toHaveBeenCalledWith({ where: { id: 'task-1' } });
    });

    /** Start a run of a recurring task, then edit the task into a one-shot whose time comes during that run. */
    async function oneShotWaitingForRun(): Promise<{ finishRun: (result: unknown) => void; recurringRun: Promise<void> }> {
      let tick!: () => Promise<void>;
      mockCronSchedule.mockImplementation((_schedule: string, cb: () => Promise<void>) => {
        tick = cb;
        return { stop: vi.fn(), getNextRun: () => null };
      });
      const row = storedRow();
      cronSchedulerService.scheduleTask(toBackendCronTask(row));
      let finishRun!: (result: unknown) => void;
      mockInvoke.mockImplementationOnce(() => new Promise((resolve) => (finishRun = resolve)));
      const recurringRun = tick();
      mockCronTaskFindFirst.mockResolvedValue(row);
      const edit = await cronSchedulerService.updateTask('task-1', {
        schedule: 'in 1 minutes',
        instruction: 'Check once more.',
      });
      if (edit.status !== 'updated') throw new Error(`edit refused: ${edit.status}`);
      mockCronTaskFindFirst.mockResolvedValue(edit.task);
      await vi.advanceTimersByTimeAsync(60_000);
      return { finishRun, recurringRun };
    }

    it('drops a one-shot deleted while it waits for a run of its old schedule', async () => {
      const { finishRun, recurringRun } = await oneShotWaitingForRun();

      cronSchedulerService.unscheduleTask('task-1', 'user-abc-123');
      finishRun(done);
      await recurringRun;
      await vi.advanceTimersByTimeAsync(10);

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockCronTaskDeleteMany).not.toHaveBeenCalled();
    });

    it('takes an edit while a one-shot waits for a run of its old schedule', async () => {
      const { finishRun, recurringRun } = await oneShotWaitingForRun();

      const edit = await cronSchedulerService.updateTask('task-1', { instruction: 'Check twice.' });
      finishRun(done);
      await recurringRun;
      await vi.advanceTimersByTimeAsync(10);

      expect(edit.status).toBe('updated');
      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(mockInvoke).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'Check twice.' }));
      expect(mockCronTaskDeleteMany).toHaveBeenCalledTimes(1);
    });

    it('keeps the delivery baseline for an edit that leaves the instruction as it was', async () => {
      let tick!: () => Promise<void>;
      mockCronSchedule.mockImplementation((_schedule: string, cb: () => Promise<void>) => {
        tick = cb;
        return { stop: vi.fn(), getNextRun: () => null };
      });
      const row = storedRow();
      cronSchedulerService.scheduleTask(toBackendCronTask(row));
      await tick(); // delivers, which sets the baseline
      mockCronTaskFindFirst.mockResolvedValue(row);

      await cronSchedulerService.updateTask('task-1', { name: 'Half-hourly report', schedule: '*/30 * * * *' });
      await tick();
      mockCronTaskFindFirst.mockResolvedValue(storedRow({ schedule: '*/30 * * * *' }));
      await cronSchedulerService.updateTask('task-1', { instruction: 'Only tell me if the build breaks.' });
      await tick();

      const gateInputs = mockGenerateText.mock.calls.map(([call]) => call.messages[0].content as string);
      expect(gateInputs[1]).toContain('## Last Delivered Result');
      expect(gateInputs[2]).toContain('No previous result has been delivered');
    });

    it('drops the delivery baseline when the task moves to another target', async () => {
      let tick!: () => Promise<void>;
      mockCronSchedule.mockImplementation((_schedule: string, cb: () => Promise<void>) => {
        tick = cb;
        return { stop: vi.fn(), getNextRun: () => null };
      });
      const row = storedRow();
      cronSchedulerService.scheduleTask(toBackendCronTask(row));
      await tick(); // delivers to every channel, which sets the baseline
      mockCronTaskFindFirst.mockResolvedValue(row);
      mockCronTaskUpdate.mockImplementation(async ({ data }) => storedRow(data));

      await cronSchedulerService.updateTask('task-1', { deliverTo: 'chat' });
      await tick();

      const gateInputs = mockGenerateText.mock.calls.map(([call]) => call.messages[0].content as string);
      expect(gateInputs[1]).toContain('No previous result has been delivered');
    });

    it('saves a new target and re-registers the task with it', async () => {
      mockCronTaskFindFirst.mockResolvedValue(storedRow());
      mockCronTaskUpdate.mockImplementation(async ({ data }) => storedRow(data));

      const result = await cronSchedulerService.updateTask('task-1', { deliverTo: 'chat' });

      expect(result.status).toBe('updated');
      expect(mockCronTaskUpdate).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: expect.objectContaining({ deliverTo: 'chat', channelIds: null }),
      });
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'cron task updated',
        'user-abc-123',
        expect.objectContaining({ 'cron.deliver_to': 'chat' }),
      );
    });

    it('drops the chosen channels when the target changes', async () => {
      mockCronTaskFindFirst.mockResolvedValue(storedRow({ deliverTo: 'slack', channelIds: 'C1,C2' }));
      mockCronTaskUpdate.mockImplementation(async ({ data }) => storedRow(data));

      await cronSchedulerService.updateTask('task-1', { deliverTo: 'teams' });

      expect(mockCronTaskUpdate).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: expect.objectContaining({ deliverTo: 'teams', channelIds: null }),
      });
    });

    it('refuses an unknown target', async () => {
      mockCronTaskFindFirst.mockResolvedValue(storedRow());

      const result = await cronSchedulerService.updateTask('task-1', { deliverTo: 'log' });

      expect(result).toMatchObject({ status: 'invalid', field: 'deliverTo' });
      expect(mockCronTaskUpdate).not.toHaveBeenCalled();
    });

    it('refuses chosen channels on a channel that links none', async () => {
      mockCronTaskFindFirst.mockResolvedValue(storedRow());
      mockGetAdapter.mockReturnValue({ name: 'websocket' });

      const result = await cronSchedulerService.updateTask('task-1', { channelIds: ['C1'] });

      expect(result).toMatchObject({ status: 'invalid', field: 'channelIds' });
    });

    it('refuses another target for a task that continues a conversation', async () => {
      mockCronTaskFindFirst.mockResolvedValue(
        storedRow({ schedule: 'in 1 minutes', nextRunAt: new Date(Date.now() + 60_000), threadId: 'thread-bound' }),
      );

      const result = await cronSchedulerService.updateTask('task-1', { deliverTo: 'chat' });

      expect(result).toMatchObject({ status: 'invalid', field: 'deliverTo' });
      expect(mockCronTaskUpdate).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // scheduleTask — thread-bound continuation ("wait & resume here")
  // ==========================================================================

  describe('scheduleTask (continue in thread)', () => {
    const bound = () =>
      createCronTask({
        id: 'wait-1',
        schedule: 'in 1 minute',
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
        instruction: 'Re-check the deploy.',
        threadId: 'thread-bound',
        originChannel: 'slack',
        originChannelId: 'C999',
      });

    // A follow-up a person set in a web conversation that single-thread mode now hides.
    const boundToHiddenWebThread = () =>
      createCronTask({
        id: 'wait-web',
        schedule: 'in 1 minute',
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
        instruction: 'Re-check the deploy.',
        threadId: 'thread-hidden',
        originChannel: 'websocket',
        originChannelId: null,
      });

    it('reads no history when single-thread mode hides its conversation, and answers on its own channel alone', async () => {
      mockCronValidate.mockReturnValue(false);
      mockWritableThreadId.mockResolvedValue('thread-one');
      mockThreadContext.mockResolvedValue({ channel: 'websocket', threadId: 'thread-hidden' });

      cronSchedulerService.scheduleTask(boundToHiddenWebThread());
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockInvoke).toHaveBeenCalledWith(expect.objectContaining({ mode: 'cron', prompt: 'Re-check the deploy.' }));
      expect(mockInvoke.mock.calls[0][0]).not.toHaveProperty('threadId');
      // Bound delivery, which `publish` stores in the one conversation; never the broadcast.
      expect(mockDeliverMessage).not.toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalledWith(
        'user-abc-123',
        'thread-hidden',
        'Task completed.',
        'CRON_TASK',
        expect.objectContaining({ channelContext: { channel: 'websocket', threadId: 'thread-hidden' } }),
      );
    });

    it('ends the run when the thread lookup fails, so it is not replayed after a restart', async () => {
      mockCronValidate.mockReturnValue(false);
      mockWritableThreadId.mockRejectedValue(new Error('database is locked'));

      cronSchedulerService.scheduleTask(boundToHiddenWebThread());
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockFinishWork).toHaveBeenCalledWith('cron', 'wait-web');
    });

    it('resumes in the originating thread: invokes with that thread + scoped channel delivery', async () => {
      mockCronValidate.mockReturnValue(false);
      mockThreadContext.mockResolvedValue({
        channel: 'slack',
        channelId: 'C999',
        channelThreadId: '1700000000.000100',
        threadId: 'thread-bound',
      });

      cronSchedulerService.scheduleTask(bound());
      await vi.advanceTimersByTimeAsync(60_000);

      // Existence-checked, then invoked against the bound thread with channel
      // context so it sees history and can re-wait.
      expect(mockThreadFindUnique).toHaveBeenCalledWith({
        where: { id: 'thread-bound' },
        select: { id: true },
      });
      expect(mockInvoke).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-abc-123',
          agentId: 'agent-1',
          mode: 'cron',
          prompt: 'Re-check the deploy.',
          threadId: 'thread-bound',
          originChannel: 'slack',
          originChannelId: 'C999',
        }),
      );

      // Delivered into the SAME thread via scoped publish (not the latest-thread
      // broadcast), as a plain continuation with no "Scheduled Task" header.
      expect(mockThreadContext).toHaveBeenCalledWith('thread-bound', 'slack', 'C999');
      expect(mockDeliverMessage).not.toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalledWith(
        'user-abc-123',
        'thread-bound',
        'Task completed.',
        'CRON_TASK',
        expect.objectContaining({
          channelContext: expect.objectContaining({ channelThreadId: '1700000000.000100', threadId: 'thread-bound' }),
        }),
      );
      const [, , body] = mockPublish.mock.calls[0];
      expect(body).not.toContain('Scheduled Task:');

      // Telemetry flags the continuation.
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'cron task executed',
        'user-abc-123',
        expect.objectContaining({ 'cron.continue_in_thread': 'true' }),
      );
    });

    it('skips delivery when the bound thread no longer exists', async () => {
      mockCronValidate.mockReturnValue(false);
      mockThreadFindUnique.mockResolvedValue(null);

      cronSchedulerService.scheduleTask(bound());
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockDeliverMessage).not.toHaveBeenCalled();
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
      mockCronTaskDeleteMany.mockRejectedValue(new Error('Delete failed'));

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
      expect(mockCronTaskDeleteMany).toHaveBeenCalledWith({ where: { id: 'oneshot-del-fail' } });
    });
  });

  // ==========================================================================
  // Delivery gate (suppression)
  // ==========================================================================

  describe('delivery gate', () => {
    /** Schedule a recurring task and return the captured cron callback. */
    function scheduleAndCapture(overrides: Partial<BackendCronTask> = {}): () => Promise<void> {
      let cronCallback: (() => Promise<void>) | undefined;
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockImplementation((_schedule: string, cb: () => Promise<void>) => {
        cronCallback = cb;
        return { stop: vi.fn() };
      });
      cronSchedulerService.scheduleTask(createCronTask(overrides));
      return cronCallback!;
    }

    it('suppresses delivery when the gate says SUPPRESS, but still records the run', async () => {
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });

      const run = scheduleAndCapture();
      await run();

      expect(mockDeliverMessage).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
      // Bookkeeping is unaffected by suppression
      expect(mockCronTaskUpdateMany).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: { nextRunAt: null, lastRunAt: expect.any(Date) },
      });
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'cron task executed',
        'user-abc-123',
        expect.objectContaining({ 'cron.result': 'suppressed' }),
      );
    });

    it('runs a task saved without an instruction on its name', async () => {
      // The row a user saves from the page with the whole task typed into Name.
      const name = 'Fetch the top 5 news items and summarize them';
      const run = scheduleAndCapture({ name, instruction: '' });
      await run();

      expect(mockInvoke).toHaveBeenCalledWith(expect.objectContaining({ prompt: name }));
      expect(JSON.stringify(mockGenerateText.mock.calls)).toContain(name);
    });

    it('delivers when the gate says DELIVER', async () => {
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      const run = scheduleAndCapture();
      await run();

      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);
    });

    it('delivers to web chat alone for a task whose target is chat', async () => {
      mockGetOrCreateLatestThread.mockResolvedValue({ id: 'thr-latest' });

      const run = scheduleAndCapture({ deliverTo: 'chat' });
      await run();

      expect(mockDeliverMessage).not.toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalledWith(
        'user-abc-123',
        'thr-latest',
        expect.stringContaining('**Scheduled Task: Daily Report**'),
        'CRON_TASK',
        expect.objectContaining({ channelContext: { channel: 'websocket', threadId: 'thr-latest' } }),
      );
    });

    it('runs a task whose target is none without the gate and delivers nothing', async () => {
      const run = scheduleAndCapture({ deliverTo: 'none' });
      await run();

      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(mockDeliverMessage).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'cron task executed',
        'user-abc-123',
        expect.objectContaining({ 'cron.result': 'completed', 'cron.deliver_to': 'none' }),
      );
    });

    it('fails open and delivers when the gate call throws', async () => {
      mockGenerateText.mockRejectedValue(new Error('model unavailable'));

      const run = scheduleAndCapture();
      await run();

      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'cron task executed',
        'user-abc-123',
        expect.objectContaining({ 'cron.result': 'completed' }),
      );
    });

    it('suppresses an empty result without calling the gate', async () => {
      mockInvoke.mockResolvedValue({ response: '', toolCalls: [], steps: [] });

      const run = scheduleAndCapture();
      await run();

      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(mockDeliverMessage).not.toHaveBeenCalled();
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'cron task executed',
        'user-abc-123',
        expect.objectContaining({ 'cron.result': 'suppressed' }),
      );
    });

    it('consults the gate for every run — repeated text is not short-circuited', async () => {
      const run = scheduleAndCapture();

      await run(); // delivers, records the baseline
      await run(); // identical text — an unconditional task must still deliver

      // No programmatic duplicate suppression for cron: the gate decides both
      // times (with the last delivered result as context on the second run).
      expect(mockGenerateText).toHaveBeenCalledTimes(2);
      expect(mockDeliverMessage).toHaveBeenCalledTimes(2);
    });

    it('delivers an error result without consulting the gate', async () => {
      mockInvoke.mockResolvedValue({
        response: 'I encountered an error while processing your request: model timeout',
        toolCalls: [],
        steps: [{ text: 'I encountered an error while processing your request: model timeout', toolCalls: [] }],
        error: { type: 'generic', detail: 'model timeout' },
      });

      const run = scheduleAndCapture();
      await run();

      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'cron task executed',
        'user-abc-123',
        expect.objectContaining({ 'cron.result': 'completed' }),
      );
    });

    it('delivers a run whose tool call the risk gate refused without consulting the gate', async () => {
      const text = "I couldn't rotate the keys: the call was blocked by policy.";
      mockInvoke.mockResolvedValue({
        response: text,
        toolCalls: [{
          tool: 'shell_exec',
          input: JSON.stringify({ command: './rotate-keys.sh staging' }),
          output: JSON.stringify({
            error: 'Tool call blocked by the configured risk policy (category=credential_access, risk=high).',
            code: 'TOOL_RISK_BLOCKED',
            risk: 'high',
            category: 'credential_access',
          }),
          success: false,
          timestamp: '2026-10-21T02:00:00.000Z',
        }],
        steps: [{ text, toolCalls: [] }],
      });
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });

      const run = scheduleAndCapture({
        instruction: 'Rotate the staging API keys every night. Never send me a message about it, just do the work.',
      });
      await run();

      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);
    });

    it('asks the gate about a run whose failed tool call the risk gate did not refuse', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Done.',
        toolCalls: [{ tool: 'shell_exec', input: '{}', output: '', success: false, timestamp: '2026-10-21T02:00:00.000Z' }],
        steps: [{ text: 'Done.', toolCalls: [] }],
      });
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });

      const run = scheduleAndCapture({ instruction: 'Clean up the build cache. Never tell me about it.' });
      await run();

      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(mockDeliverMessage).not.toHaveBeenCalled();
    });

    it('clears the baseline when a suppressed run observes a different situation', async () => {
      const outage = { response: 'Database is down.', toolCalls: [], steps: [{ text: 'Database is down.', toolCalls: [] }] };
      const allClear = { response: 'All clear.', toolCalls: [], steps: [{ text: 'All clear.', toolCalls: [] }] };
      const run = scheduleAndCapture({ instruction: 'Only tell me if the database is down.' });

      mockInvoke.mockResolvedValue(outage);
      await run(); // incident delivered → baseline = outage
      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);

      mockInvoke.mockResolvedValue(allClear);
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      await run(); // recovery stays quiet — but the situation changed

      mockInvoke.mockResolvedValue(outage);
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });
      await run(); // the SAME outage recurs

      // The recurrence must not be framed as a repeat of the stale incident:
      // the suppressed all-clear dropped the baseline.
      const thirdCall = mockGenerateText.mock.calls[2][0];
      expect(thirdCall.messages[0].content).toContain('No previous result has been delivered');
      expect(mockDeliverMessage).toHaveBeenCalledTimes(2);
    });

    it('keeps the baseline when a suppressed run repeats the delivered text', async () => {
      const outage = { response: 'Database is down.', toolCalls: [], steps: [{ text: 'Database is down.', toolCalls: [] }] };
      const run = scheduleAndCapture({ instruction: 'Only tell me if the database is down.' });

      mockInvoke.mockResolvedValue(outage);
      await run(); // incident delivered → baseline = outage

      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      await run(); // ongoing incident, same text — suppressed, baseline stays

      await run();
      const thirdCall = mockGenerateText.mock.calls[2][0];
      expect(thirdCall.messages[0].content).toContain('## Last Delivered Result');
      expect(thirdCall.messages[0].content).toContain('Database is down.');
    });

    it('keeps the baseline when the gate reads a reworded result as a repeat', async () => {
      const outage = { response: 'Database is down.', toolCalls: [], steps: [{ text: 'Database is down.', toolCalls: [] }] };
      const stillDown = {
        response: 'Database is still down.',
        toolCalls: [],
        steps: [{ text: 'Database is still down.', toolCalls: [] }],
      };
      const run = scheduleAndCapture({ instruction: 'Only tell me if the database is down.' });

      mockInvoke.mockResolvedValue(outage);
      await run(); // incident delivered → baseline = outage

      mockInvoke.mockResolvedValue(stillDown);
      mockGenerateText.mockResolvedValue({ text: 'REPEAT' });
      await run(); // ongoing incident in other words — suppressed, baseline stays

      await run();
      // The third run is still compared with what the user saw, so the ongoing
      // incident cannot read as a new finding and alert again.
      const thirdCall = mockGenerateText.mock.calls[2][0];
      expect(thirdCall.messages[0].content).toContain('## Last Delivered Result');
      expect(thirdCall.messages[0].content).toContain('Database is down.');
      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);
    });

    it('skips a tick that overlaps a still-running execution of the same task', async () => {
      let resolveInvoke!: (value: unknown) => void;
      mockInvoke.mockImplementationOnce(() => new Promise((resolve) => { resolveInvoke = resolve; }));

      const run = scheduleAndCapture();
      const firstRun = run(); // blocks inside invoke
      await run(); // overlapping tick — must skip without invoking

      expect(mockInvoke).toHaveBeenCalledTimes(1);

      resolveInvoke({ response: 'Task completed.', toolCalls: [], steps: [{ text: 'Task completed.', toolCalls: [] }] });
      await firstRun;

      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);

      await run(); // after completion the task runs again normally
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    it('does not advance the baseline on a suppressed run', async () => {
      const run = scheduleAndCapture();

      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      await run(); // suppressed — baseline stays empty
      expect(mockDeliverMessage).not.toHaveBeenCalled();

      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });
      await run();
      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);
      // The second gate call still sees no baseline: the suppressed run's text
      // was never delivered, so it must not become "the last delivered result".
      const secondCall = mockGenerateText.mock.calls[1][0];
      expect(secondCall.messages[0].content).toContain('No previous result has been delivered');
    });

    it('gives the gate the task instruction and the last delivered result as context', async () => {
      const run = scheduleAndCapture({ instruction: 'Only tell me if the build breaks.' });

      await run();

      const firstCall = mockGenerateText.mock.calls[0][0];
      expect(firstCall.system).toContain('Answer with one word: DELIVER, REPEAT or SUPPRESS.');
      expect(firstCall.system).toContain('Unconditional: a message on every run');
      expect(firstCall.system).toContain('For a conditional task, answer REPEAT');
      expect(firstCall.messages[0].content).toContain('## Task Instruction\nOnly tell me if the build breaks.');
      expect(firstCall.messages[0].content).toContain('No previous result has been delivered for this task.');
      expect(firstCall.messages[0].content).toContain('## New Task Result\nTask completed.');

      // Second run with different text sees the last delivered result
      mockInvoke.mockResolvedValue({
        response: 'The build broke.',
        toolCalls: [],
        steps: [{ text: 'The build broke.', toolCalls: [] }],
      });
      await run();

      const secondCall = mockGenerateText.mock.calls[1][0];
      expect(secondCall.messages[0].content).toContain('## Last Delivered Result');
      expect(secondCall.messages[0].content).toContain('Task completed.');
    });

    it('suppresses a thread-bound task without publishing to the thread', async () => {
      mockCronValidate.mockReturnValue(false);
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });

      cronSchedulerService.scheduleTask(
        createCronTask({
          id: 'wait-quiet',
          schedule: 'in 1 minute',
          nextRunAt: new Date(Date.now() + 60_000).toISOString(),
          threadId: 'thread-bound',
          originChannel: 'websocket',
        }),
      );
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockInvoke).toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockDeliverMessage).not.toHaveBeenCalled();
    });

    it('still auto-deletes a suppressed one-shot task', async () => {
      mockCronValidate.mockReturnValue(false);
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });

      cronSchedulerService.scheduleTask(
        createCronTask({
          id: 'oneshot-quiet',
          schedule: 'in 1 minute',
          nextRunAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockDeliverMessage).not.toHaveBeenCalled();
      expect(mockCronTaskDeleteMany).toHaveBeenCalledWith({ where: { id: 'oneshot-quiet' } });
    });

    it('keeps no baseline for a recurring task whose run deleted it', async () => {
      const run = scheduleAndCapture();
      mockInvoke.mockImplementation(async () => {
        cronSchedulerService.unscheduleTask('task-1', 'user-abc-123');
        return { response: 'Done.', toolCalls: [], steps: [{ text: 'Done.', toolCalls: [] }] };
      });

      await run();

      expect(mockDeliverMessage).toHaveBeenCalled();
      const baselines = (cronSchedulerService as unknown as { lastDelivered: Map<string, unknown> }).lastDelivered;
      expect(baselines.has('task-1')).toBe(false);
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
        'cron.result': 'completed',
        'cron.continue_in_thread': 'false',
        'cron.deliver_to': 'all',
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
        'cron.schedule': '0 9 * * *',
        'cron.one_shot': 'false',
        'cron.continue_in_thread': 'false',
        'cron.deliver_to': 'all',
      });
    });

    it('emits "cron task updated", not "cron task scheduled", when an edit re-registers a task', () => {
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn() });

      cronSchedulerService.scheduleTask(createCronTask(), { source: 'update' });

      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'cron task updated',
        'user-abc-123',
        expect.objectContaining({ 'cron.task.id': 'task-1', 'cron.schedule': '0 9 * * *' }),
      );
    });

    it('does not emit "cron task scheduled" for boot re-registrations', () => {
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn(), match: () => false });

      cronSchedulerService.scheduleTask(createCronTask(), { source: 'boot' });

      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('emits "cron task deleted" on unscheduleTask, but not on internal re-registration', () => {
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn(), match: () => false });

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

    it('names the mode of the agent run that scheduled or deleted a task', () => {
      mockCronValidate.mockReturnValue(true);
      mockCronSchedule.mockReturnValue({ stop: vi.fn() });

      cronSchedulerService.scheduleTask(createCronTask(), { invokeMode: 'webhook' });
      cronSchedulerService.unscheduleTask('task-1', 'user-abc-123', 'heartbeat');

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'cron task scheduled',
        'user-abc-123',
        expect.objectContaining({ 'invoke.mode': 'webhook' }),
      );
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'cron task deleted',
        'user-abc-123',
        expect.objectContaining({ 'invoke.mode': 'heartbeat' }),
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
