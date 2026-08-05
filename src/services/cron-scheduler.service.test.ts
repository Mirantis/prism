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
  mockGetChannelContext,
  mockThreadFindUnique,
  mockCronTaskUpdate,
  mockCronTaskDelete,
  mockCronTaskFindMany,
  mockCronSchedule,
  mockCronValidate,
  mockGenerateText,
  mockGetClassificationModel,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockDeliverMessage: vi.fn(),
  mockPublish: vi.fn(),
  mockGetChannelContext: vi.fn(),
  mockThreadFindUnique: vi.fn(),
  mockCronTaskUpdate: vi.fn(),
  mockCronTaskDelete: vi.fn(),
  mockCronTaskFindMany: vi.fn(),
  mockCronSchedule: vi.fn(),
  mockCronValidate: vi.fn(),
  mockGenerateText: vi.fn(),
  mockGetClassificationModel: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('../invoke', () => ({
  invoke: mockInvoke,
}));

vi.mock('./message-delivery.service', () => ({
  messageDeliveryService: {
    publishToLatestThread: mockDeliverMessage,
    publish: mockPublish,
  },
}));

vi.mock('./conversation.service', () => ({
  conversationService: {
    getChannelContext: mockGetChannelContext,
  },
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    cronTask: {
      findMany: mockCronTaskFindMany,
      update: mockCronTaskUpdate,
      delete: mockCronTaskDelete,
    },
    conversationThread: {
      findUnique: mockThreadFindUnique,
    },
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
  getClassificationModel: mockGetClassificationModel,
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
    threadId: null,
    originChannel: null,
    originChannelId: null,
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
    mockGetChannelContext.mockResolvedValue({ channel: 'websocket', threadId: 'thread-bound' });
    mockThreadFindUnique.mockResolvedValue({ id: 'thread-bound' });
    mockCronTaskUpdate.mockResolvedValue({});
    mockCronTaskDelete.mockResolvedValue({});
    // Default: gate delivers (the suppression suite overrides this)
    mockGenerateText.mockResolvedValue({ text: 'DELIVER' });
    mockGetClassificationModel.mockReturnValue('classification-model');
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

    it('resumes in the originating thread: invokes with that thread + scoped channel delivery', async () => {
      mockCronValidate.mockReturnValue(false);
      mockGetChannelContext.mockResolvedValue({
        channel: 'slack',
        channelId: 'C999',
        threadTs: '1700000000.000100',
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
      expect(mockGetChannelContext).toHaveBeenCalledWith('thread-bound', 'slack', 'C999');
      expect(mockDeliverMessage).not.toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalledWith(
        'user-abc-123',
        'thread-bound',
        'Task completed.',
        'CRON_TASK',
        expect.objectContaining({
          channelContext: expect.objectContaining({ threadTs: '1700000000.000100', threadId: 'thread-bound' }),
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
      expect(mockCronTaskUpdate).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: { lastRunAt: expect.any(Date) },
      });
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'cron task executed',
        'user-abc-123',
        expect.objectContaining({ 'cron.result': 'suppressed' }),
      );
    });

    it('delivers when the gate says DELIVER', async () => {
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      const run = scheduleAndCapture();
      await run();

      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);
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
      expect(firstCall.system).toContain('Respond with exactly one word: DELIVER or SUPPRESS');
      expect(firstCall.system).toContain('UNCONDITIONAL: the user asked to receive a message on every run');
      expect(firstCall.system).toContain("Only a CONDITIONAL task's result may be suppressed");
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
      expect(mockCronTaskDelete).toHaveBeenCalledWith({ where: { id: 'oneshot-quiet' } });
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
        'cron.continue_in_thread': 'false',
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
        'cron.continue_in_thread': 'false',
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
