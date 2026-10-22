/**
 * Heartbeat Service Tests
 *
 * Tests for HeartbeatService: startHeartbeat, stopHeartbeat, triggerHeartbeat,
 * getStatus, duplicate alert suppression, classification gate LLM,
 * consecutive error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockInvoke,
  mockDeliverMessage,
  mockUpdateHeartbeatSchedule,
  mockUpdateAgentHeartbeatStatus,
  mockPendingTriggerMessages,
  mockGenerateText,
  mockGetGateRequest,
  mockLoggerInfo,
  mockLoggerDebug,
  mockLoggerError,
  mockRemoveTriggerMessages,
  mockFindLastAlert,
  mockFindChecks,
  mockNewestRevision,
  mockBeginWork,
  mockFinishWork,
  shutdown,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockDeliverMessage: vi.fn(),
  mockUpdateHeartbeatSchedule: vi.fn(),
  mockUpdateAgentHeartbeatStatus: vi.fn(),
  mockPendingTriggerMessages: vi.fn(),
  mockGenerateText: vi.fn(),
  mockGetGateRequest: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerDebug: vi.fn(),
  mockLoggerError: vi.fn(),
  mockRemoveTriggerMessages: vi.fn(),
  mockFindLastAlert: vi.fn(),
  mockFindChecks: vi.fn(),
  mockNewestRevision: vi.fn(),
  mockBeginWork: vi.fn(async () => undefined),
  mockFinishWork: vi.fn(),
  shutdown: { controller: new AbortController() },
}));

vi.mock('../invoke', () => ({
  invoke: mockInvoke,
}));

vi.mock('./message-delivery.service', () => ({
  messageDeliveryService: {
    publishToLatestThread: mockDeliverMessage,
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

vi.mock('../lib/prisma', () => ({
  default: {
    conversationMessage: { findMany: mockFindLastAlert },
    agentWorkspace: { findUniqueOrThrow: mockFindChecks },
    agentWorkspaceRevision: { findFirst: mockNewestRevision },
  },
}));

vi.mock('./agent-status.service', () => ({
  agentStatusService: {
    updateHeartbeatSchedule: mockUpdateHeartbeatSchedule,
    updateAgentHeartbeatStatus: mockUpdateAgentHeartbeatStatus,
  },
}));

vi.mock('ai', () => ({
  generateText: mockGenerateText,
}));

vi.mock('../lib/classification', () => ({
  getGateRequest: mockGetGateRequest,
}));

const { mockTrackEvent } = vi.hoisted(() => ({ mockTrackEvent: vi.fn() }));
const { mockKeepWithheldRun } = vi.hoisted(() => ({ mockKeepWithheldRun: vi.fn() }));

vi.mock('./outbound-message.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./outbound-message.service')>()),
  outboundMessageService: { keepWithheldRun: mockKeepWithheldRun },
}));

vi.mock('../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
}));

vi.mock('../logger', () => ({
  logger: {
    info: mockLoggerInfo,
    debug: mockLoggerDebug,
    error: mockLoggerError,
    warn: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { heartbeatService } from './heartbeat.service';

/**
 * A channel that queues messages for the heartbeat. Each test lists the messages;
 * the ids are the rows a finished run removes.
 */
const triggerSource = {
  channel: 'slack',
  platform: 'Slack',
  pending: async (agentId: string) => {
    const messages = (await mockPendingTriggerMessages(agentId)) as unknown[];
    return { ids: messages.map((_, i) => `pending-${i}`), messages };
  },
  remove: mockRemoveTriggerMessages,
};
heartbeatService.registerTriggerSource(triggerSource);
import { AgentWorkspace } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAgent(overrides: Record<string, unknown> = {}): AgentWorkspace {
  return {
    id: 'agent-1',
    userId: 'user-abc-123',
    name: 'TestAgent',
    agentType: 'AGENT' as const,
    soulMd: '',
    userMd: '',
    memoryMd: '',
    heartbeatMd: 'Check for new items.',
    visionMd: '',
    agentMd: '',
    bootstrapMd: '',
    heartbeatIntervalMs: 28_800_000,
    heartbeatStatus: 'ENABLED' as const,
    timezone: 'UTC',
    model: null,
    dailyResetHour: 4,
    idleTimeoutMins: null,
    status: 'IDLE' as const,
    lastHeartbeat: null,
    nextHeartbeatAt: null,
    currentSessionId: null,
    nexusMcpAgentToken: null,
    nexusAgentTokenId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as AgentWorkspace;
}

/** The two schedule columns a write may carry. */
type ScheduleWrite = { lastHeartbeat?: Date; nextHeartbeatAt?: Date };

/**
 * The row a boot reads. Built by replaying the writes the service made onto the
 * starting row, so a deadline the service never persists cannot survive a
 * restart by being restated here.
 */
function persistedRow(agent: AgentWorkspace): AgentWorkspace {
  let lastHeartbeat = agent.lastHeartbeat;
  let nextHeartbeatAt: Date | null = null;

  for (const call of mockUpdateHeartbeatSchedule.mock.calls) {
    const write = call[0] as ScheduleWrite;
    if (write.lastHeartbeat) lastHeartbeat = write.lastHeartbeat;
    if (write.nextHeartbeatAt) nextHeartbeatAt = write.nextHeartbeatAt;
  }

  return createAgent({ ...agent, lastHeartbeat, nextHeartbeatAt });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HeartbeatService', () => {
  beforeEach(() => {
    vi.useFakeTimers();

    // Default: gate suppresses (most tests override this)
    mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
    mockGetGateRequest.mockReturnValue({
      model: 'classification-model',
      providerOptions: {},
      samplingParams: { temperature: 0 },
    });
    // Sensible defaults
    mockInvoke.mockResolvedValue({ response: 'All systems healthy.', toolCalls: [], steps: [] });
    mockUpdateHeartbeatSchedule.mockResolvedValue(undefined);
    mockUpdateAgentHeartbeatStatus.mockResolvedValue(undefined);
    mockDeliverMessage.mockResolvedValue({ messageId: 'msg-1', threadId: 'thr-1' });
    mockPendingTriggerMessages.mockResolvedValue([]);
    mockRemoveTriggerMessages.mockResolvedValue(undefined);
    mockFindLastAlert.mockResolvedValue([]);
    mockFindChecks.mockResolvedValue({ heartbeatMd: 'Check for new items.' });
    mockNewestRevision.mockResolvedValue(null);
    shutdown.controller = new AbortController();
  });

  afterEach(() => {
    heartbeatService.stopAll();
    vi.useRealTimers();
  });

  // ==========================================================================
  // startHeartbeat / stopHeartbeat
  // ==========================================================================

  describe('startHeartbeat', () => {
    it('registers the agent and marks heartbeat as active', () => {
      const agent = createAgent();
      heartbeatService.startHeartbeat(agent, 'keep-schedule');

      const status = heartbeatService.getStatus();
      expect(status).toMatchObject({
        isActive: true,
        lastRun: null,
        isRunning: false,
        consecutiveErrors: 0,
      });
    });

    it('uses default interval when heartbeatIntervalMs is falsy', async () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      const agent = createAgent({ heartbeatIntervalMs: 0 });
      heartbeatService.startHeartbeat(agent, 'keep-schedule');

      // Verify the timer was armed for the 8-hour default (28,800,000ms)
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 28_800_000);
      setTimeoutSpy.mockRestore();

      // Should NOT fire at 1 minute (old default)
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockInvoke).not.toHaveBeenCalled();

      // SHOULD fire at 8 hours
      await vi.advanceTimersByTimeAsync(28_800_000 - 60_000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('skips starting when agent has heartbeatStatus STOPPED', () => {
      const agent = createAgent({ heartbeatStatus: 'STOPPED' });
      heartbeatService.startHeartbeat(agent, 'keep-schedule');

      expect(mockUpdateAgentHeartbeatStatus).not.toHaveBeenCalled();
    });

    it('persists ENABLED status to backend when starting', () => {
      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');

      expect(mockUpdateAgentHeartbeatStatus).toHaveBeenCalledWith('ENABLED');
    });

    it('stops existing heartbeat before starting a new one (no duplicates)', () => {
      const agent = createAgent();
      heartbeatService.startHeartbeat(agent, 'keep-schedule');
      heartbeatService.startHeartbeat(agent, 'keep-schedule');
    });
  });

  describe('stopHeartbeat', () => {
    it('removes the agent from active heartbeats', () => {
      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      heartbeatService.stopHeartbeat();

      expect(heartbeatService.getStatus()).toBeNull();
    });

    it('persists STOPPED status to backend when stopping', () => {
      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      mockUpdateAgentHeartbeatStatus.mockClear();

      heartbeatService.stopHeartbeat();

      expect(mockUpdateAgentHeartbeatStatus).toHaveBeenCalledWith('STOPPED');
    });

    it('is a no-op when agentId does not exist', () => {
      // Should not throw
      heartbeatService.stopHeartbeat();
    });
  });

  describe('stopAll', () => {
    it('removes all active heartbeats', () => {
      heartbeatService.startHeartbeat(createAgent({ id: 'agent-a', userId: 'user-1' }), 'keep-schedule');
      heartbeatService.startHeartbeat(createAgent({ id: 'agent-b', userId: 'user-2' }), 'keep-schedule');

      heartbeatService.stopAll();
    });

    it('does not persist STOPPED status (graceful shutdown should not corrupt state)', () => {
      heartbeatService.startHeartbeat(createAgent({ id: 'agent-a', userId: 'user-1' }), 'keep-schedule');
      heartbeatService.startHeartbeat(createAgent({ id: 'agent-b', userId: 'user-2' }), 'keep-schedule');
      mockUpdateAgentHeartbeatStatus.mockClear();

      heartbeatService.stopAll();

      // stopAll uses clearHeartbeatTimer (in-memory only), not stopHeartbeat
      expect(mockUpdateAgentHeartbeatStatus).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // getStatus
  // ==========================================================================

  describe('getStatus', () => {
    it('returns null for unknown agent', () => {
      expect(heartbeatService.getStatus()).toBeNull();
    });

    it('returns current state for registered agent', () => {
      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');

      const status = heartbeatService.getStatus();

      expect(status).toEqual({
        isActive: true,
        lastRun: null,
        isRunning: false,
        consecutiveErrors: 0,
        intervalMs: 28_800_000,
      });
    });
  });

  // ==========================================================================
  // executeHeartbeat / triggerHeartbeat
  // ==========================================================================

  describe('triggerHeartbeat (executeHeartbeat)', () => {
    it('skips when heartbeat is already running', async () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');

      // Simulate a long-running heartbeat
      let resolveInvoke!: (v: unknown) => void;
      mockInvoke.mockReturnValue(new Promise(r => { resolveInvoke = r; }));

      const firstRun = heartbeatService.triggerHeartbeat();

      // Second call should skip immediately
      const secondResult = await heartbeatService.triggerHeartbeat();
      expect(secondResult).toEqual({ shouldSkip: true, text: 'Already running' });

      // Clean up the pending promise
      resolveInvoke({ response: 'All systems healthy.', toolCalls: [], steps: [] });
      await firstRun;
    });

    it('invokes LLM and updates heartbeat timestamp on successful heartbeat', async () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockInvoke).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-abc-123',
          mode: 'heartbeat',
        }),
      );
      expect(mockUpdateHeartbeatSchedule).toHaveBeenCalled();
    });

    it('resets consecutiveErrors to 0 on successful run', async () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      const status = heartbeatService.getStatus();
      expect(status?.consecutiveErrors).toBe(0);
      expect(status?.lastRun).toBeTruthy();
    });
  });

  // ==========================================================================
  // Gate LLM suppression
  // ==========================================================================

  describe('what earlier runs sent', () => {
    const SEND = {
      tool: 'send_message',
      input: JSON.stringify({ target: '#ops', text: 'Build #812 failed.' }),
      output: '{}',
      success: true,
      timestamp: '2025-01-15T11:00:00Z',
    };
    const reply = (text: string, toolCalls: unknown[] = []) => ({ response: text, toolCalls, steps: [{ text, toolCalls }] });
    const sendTo = (target: string, text: string) => ({ ...SEND, input: JSON.stringify({ target, text }) });

    it("gives the next run what a run sent, also when the gate suppressed that run's reply", async () => {
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      mockInvoke.mockResolvedValueOnce(reply('Posted the build failure to #ops.', [SEND]));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();
      await heartbeatService.triggerHeartbeat();

      expect(mockInvoke.mock.calls[0][0].lastSend).toBeUndefined();
      expect(mockInvoke.mock.calls[1][0].lastSend).toEqual({
        messages: '- To #ops (just now): Build #812 failed.',
        at: expect.any(Number),
        reports: [{ text: 'Posted the build failure to #ops.', at: expect.any(Number) }],
      });
      // The delivered-alert baseline stays apart: nothing was delivered.
      expect(mockInvoke.mock.calls[1][0].lastHeartbeatAlert).toBeUndefined();
    });

    it("passes on a later run's report, and keeps the record through an empty one", async () => {
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      mockInvoke
        .mockResolvedValueOnce(reply('Posted the build failure to #ops.', [SEND]))
        .mockResolvedValueOnce(reply('Build #812 is still failing. The alert is already in #ops.'))
        .mockResolvedValueOnce(reply(''));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 4; i++) await heartbeatService.triggerHeartbeat();

      expect(mockInvoke.mock.calls[3][0].lastSend).toEqual({
        messages: '- To #ops (just now): Build #812 failed.',
        at: expect.any(Number),
        reports: [
          { text: 'Build #812 is still failing. The alert is already in #ops.', at: expect.any(Number) },
          { text: 'Posted the build failure to #ops.', at: expect.any(Number) },
        ],
      });
    });

    it('records what a run sent before it hit the spending limit', async () => {
      mockInvoke.mockResolvedValueOnce({ ...reply('', [SEND]), error: { type: 'budget_exceeded', detail: null } });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();
      await heartbeatService.triggerHeartbeat();

      expect(mockInvoke.mock.calls[1][0].lastSend).toEqual(expect.objectContaining({ messages: '- To #ops (just now): Build #812 failed.' }));
    });

    it('keeps the sends about several incidents, also to one place', async () => {
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      mockInvoke
        .mockResolvedValueOnce(reply('Posted the build failure to #ops.', [SEND]))
        .mockResolvedValueOnce(reply('Posted the disk alert to #oncall.', [sendTo('#oncall', 'Disk is 95% full.')]))
        .mockResolvedValueOnce(reply('Posted the new failure to #ops.', [sendTo('#ops', 'Build #813 failed.')]));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
      await heartbeatService.triggerHeartbeat();
      vi.setSystemTime(Date.now() + 60 * 60 * 1000);
      await heartbeatService.triggerHeartbeat();
      await heartbeatService.triggerHeartbeat();

      expect(mockInvoke.mock.calls[2][0].lastSend.messages).toBe(
        '- To #oncall (1h ago): Disk is 95% full.\n- To #ops (3h ago): Build #812 failed.',
      );
      expect(mockInvoke.mock.calls[3][0].lastSend.messages).toBe(
        '- To #ops (just now): Build #813 failed.\n- To #oncall (1h ago): Disk is 95% full.\n- To #ops (3h ago): Build #812 failed.',
      );
    });

    it("keeps an all-clear report after a later run that sent about another incident", async () => {
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      mockInvoke
        .mockResolvedValueOnce(reply('Posted the disk alert to #ops.', [sendTo('#ops', 'db-1 disk 95%.')]))
        .mockResolvedValueOnce(reply('All systems healthy.'))
        .mockResolvedValueOnce(reply('Paged #oncall about the API error rate.', [sendTo('#oncall', 'API error rate 12%.')]));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 4; i++) await heartbeatService.triggerHeartbeat();

      expect(mockInvoke.mock.calls[3][0].lastSend.reports.map((report: { text: string }) => report.text)).toEqual([
        'Paged #oncall about the API error rate.',
        'All systems healthy.',
        'Posted the disk alert to #ops.',
      ]);
    });

    it('keeps at most ten results', async () => {
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      mockInvoke.mockResolvedValueOnce(reply('Posted the build failure to #ops.', [SEND]));
      for (let i = 0; i < 11; i++) mockInvoke.mockResolvedValueOnce(reply(`Report ${i}.`));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 13; i++) {
        vi.setSystemTime(Date.now() + 60 * 1000);
        await heartbeatService.triggerHeartbeat();
      }

      const texts = mockInvoke.mock.calls[12][0].lastSend.reports.map((report: { text: string }) => report.text);
      expect(texts).toHaveLength(10);
      expect(texts[0]).toBe('Report 10.');
    });

    it('drops the results older than a newer copy of the only kept send', async () => {
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      mockInvoke
        .mockResolvedValueOnce(reply('Posted the build failure to #ops.', [SEND]))
        .mockResolvedValueOnce(reply('All clear.'))
        .mockResolvedValueOnce(reply('Posted the build failure to #ops again.', [SEND]));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 4; i++) {
        vi.setSystemTime(Date.now() + 60 * 1000);
        await heartbeatService.triggerHeartbeat();
      }

      expect(mockInvoke.mock.calls[3][0].lastSend.reports.map((report: { text: string }) => report.text)).toEqual([
        'Posted the build failure to #ops again.',
      ]);
    });

    it('restores the results of the runs since the oldest kept send after a restart', async () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      mockFindLastAlert.mockResolvedValue([
        { content: 'Paged #oncall about the API error rate.', createdAt: new Date('2025-01-15T11:30:00Z'), toolCalls: [sendTo('#oncall', 'API error rate 12%.')] },
        { content: 'All systems healthy.', createdAt: new Date('2025-01-15T11:00:00Z'), toolCalls: null },
        { content: 'This run sent a message and ended with no reply.', createdAt: new Date('2025-01-15T10:45:00Z'), toolCalls: [sendTo('#ops', 'db-2 disk 91%.')] },
        { content: 'Posted the disk alert to #ops.', createdAt: new Date('2025-01-15T10:30:00Z'), toolCalls: [sendTo('#ops', 'db-1 disk 95%.')] },
        { content: 'An early report.', createdAt: new Date('2025-01-15T10:00:00Z'), toolCalls: null },
      ]);

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();

      expect(mockInvoke.mock.calls[0][0].lastSend.reports.map((report: { text: string }) => report.text)).toEqual([
        'Paged #oncall about the API error rate.',
        'All systems healthy.',
        'Posted the disk alert to #ops.',
      ]);
    });

    it('keeps a repeated message once, at its newest time', async () => {
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      mockInvoke
        .mockResolvedValueOnce(reply('Posted the build failure to #ops.', [SEND]))
        .mockResolvedValueOnce(reply('Posted the build failure to #ops again.', [SEND]));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
      await heartbeatService.triggerHeartbeat();
      await heartbeatService.triggerHeartbeat();

      expect(mockInvoke.mock.calls[2][0].lastSend.messages).toBe('- To #ops (just now): Build #812 failed.');
    });

    it('keeps at most ten sends, dropping the oldest', async () => {
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      const sends = Array.from({ length: 11 }, (_, i) => sendTo(`#team-${i}`, `Alert ${i}.`));
      for (const send of sends) mockInvoke.mockResolvedValueOnce(reply('Posted an alert.', [send]));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 12; i++) await heartbeatService.triggerHeartbeat();

      const messages: string = mockInvoke.mock.calls[11][0].lastSend.messages;
      expect(messages.split('\n')).toHaveLength(10);
      expect(messages).toContain('#team-10');
      expect(messages).not.toContain('#team-0 (');
      expect(messages).toContain('#team-1 (');
    });

    it('drops the record when the Heartbeat document changes', async () => {
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      mockInvoke.mockResolvedValueOnce(reply('Posted the build failure to #ops.', [SEND]));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();
      await heartbeatService.triggerHeartbeat();
      mockFindChecks.mockResolvedValue({ heartbeatMd: 'Check the disk usage.' });
      await heartbeatService.triggerHeartbeat();

      expect(mockInvoke.mock.calls[1][0].lastSend).toEqual(expect.objectContaining({ messages: '- To #ops (just now): Build #812 failed.' }));
      expect(mockInvoke.mock.calls[2][0].lastSend).toBeUndefined();
    });

    it('drops a restored record when the Heartbeat document changed since the restart', async () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      mockFindLastAlert.mockResolvedValue([
        { content: 'Posted the build failure.', createdAt: new Date('2025-01-15T11:00:00Z'), toolCalls: [SEND] },
      ]);

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      mockFindChecks.mockResolvedValue({ heartbeatMd: 'Check the disk usage.' });
      await heartbeatService.triggerHeartbeat();

      expect(mockInvoke.mock.calls[0][0].lastSend).toBeUndefined();
    });

    it('drops the record on a channel-triggered run when the Heartbeat document changes', async () => {
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      mockInvoke.mockResolvedValueOnce(reply('Posted the build failure to #ops.', [SEND]));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();
      mockFindChecks.mockResolvedValue({ heartbeatMd: 'Check the disk usage.' });
      mockPendingTriggerMessages.mockResolvedValueOnce([
        { sender: 'Test Operator', text: 'is the build still red?', timestamp: '2025-01-15T12:00:00Z' },
      ]);
      heartbeatService.triggerFrom(triggerSource);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke.mock.calls[1][0].lastSend).toBeUndefined();
    });

    it('gives a channel-triggered run at boot the restored record', async () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      let answer: (rows: unknown[]) => void = () => {};
      mockFindLastAlert.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
      mockPendingTriggerMessages.mockResolvedValueOnce([
        { sender: 'Test Operator', text: 'is the build still red?', timestamp: '2025-01-15T12:00:00Z' },
      ]);

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      heartbeatService.triggerFrom(triggerSource);
      await vi.advanceTimersByTimeAsync(0);
      answer([{ content: 'Posted the build failure.', createdAt: new Date('2025-01-15T11:00:00Z'), toolCalls: [SEND] }]);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke.mock.calls[0][0].lastSend).toEqual(expect.objectContaining({ messages: '- To #ops (1h ago): Build #812 failed.' }));
    });

    it('gives a channel-triggered run the record too', async () => {
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      mockInvoke.mockResolvedValueOnce(reply('Posted the build failure to #ops.', [SEND]));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();
      mockPendingTriggerMessages.mockResolvedValueOnce([
        { sender: 'Test Operator', text: 'is the build still red?', timestamp: '2025-01-15T12:00:00Z' },
      ]);
      heartbeatService.triggerFrom(triggerSource);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke.mock.calls[1][0].lastSend).toEqual(expect.objectContaining({ messages: '- To #ops (just now): Build #812 failed.' }));
    });

    it('reads the record and the last delivered alert from the same stored messages after a restart', async () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      mockFindLastAlert.mockResolvedValue([
        { content: 'Build #812 is still failing.', createdAt: new Date('2025-01-15T11:30:00Z'), toolCalls: null },
        { content: 'Posted the build failure to #ops.', createdAt: new Date('2025-01-15T11:00:00Z'), toolCalls: [SEND] },
      ]);

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();

      expect(mockInvoke.mock.calls[0][0].lastSend).toEqual({
        messages: '- To #ops (1h ago): Build #812 failed.',
        at: new Date('2025-01-15T11:00:00Z').getTime(),
        reports: [
          { text: 'Build #812 is still failing.', at: new Date('2025-01-15T11:30:00Z').getTime() },
          { text: 'Posted the build failure to #ops.', at: new Date('2025-01-15T11:00:00Z').getTime() },
        ],
      });
      expect(mockInvoke.mock.calls[0][0].lastHeartbeatAlert).toBe('Build #812 is still failing.');
    });

    it('restores only the sends of the last three intervals', async () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      mockFindLastAlert.mockResolvedValue([
        { content: 'Posted the disk alert.', createdAt: new Date('2025-01-15T08:00:00Z'), toolCalls: [sendTo('#oncall', 'Disk is 95% full.')] },
        { content: 'Posted the build failure.', createdAt: new Date('2025-01-14T11:00:00Z'), toolCalls: [SEND] },
      ]);

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();

      expect(mockInvoke.mock.calls[0][0].lastSend.messages).toBe('- To #oncall (4h ago): Disk is 95% full.');
    });

    it('restores no send made before the newest revision of the Heartbeat document', async () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      mockInvoke.mockResolvedValueOnce(reply('Posted the build failure to #ops.', [SEND]));
      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();
      heartbeatService.stopHeartbeat();

      mockFindLastAlert.mockResolvedValue([
        { content: 'Posted the build failure.', createdAt: new Date('2025-01-15T11:00:00Z'), toolCalls: [SEND] },
      ]);
      mockNewestRevision.mockResolvedValue({ createdAt: new Date('2025-01-15T11:30:00Z') });
      heartbeatService.startHeartbeat(createAgent({ heartbeatMd: 'Check the disk usage.' }), 'keep-schedule');
      mockFindChecks.mockResolvedValue({ heartbeatMd: 'Check the disk usage.' });
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();

      expect(mockNewestRevision).toHaveBeenCalledWith({
        where: { agentId: 'agent-1', field: 'heartbeatMd' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(mockInvoke.mock.calls[1][0].lastSend).toBeUndefined();
    });

    it('restores no record when every send is older than three intervals', async () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      mockFindLastAlert.mockResolvedValue([
        { content: 'Posted the build failure.', createdAt: new Date('2025-01-14T11:00:00Z'), toolCalls: [SEND] },
      ]);

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();

      expect(mockInvoke.mock.calls[0][0].lastSend).toBeUndefined();
    });
  });

  describe('gate LLM suppression', () => {
    beforeEach(() => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
    });

    it('gate returns SUPPRESS → message not delivered', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Pod frontend-abc is in CrashLoopBackOff!',
        toolCalls: [],
        steps: [{ text: 'Pod frontend-abc is in CrashLoopBackOff!', toolCalls: [] }],
      });
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      const result = await heartbeatService.triggerHeartbeat();

      expect(result.shouldSkip).toBe(true);
      expect(result.text).toBe('');
      expect(mockDeliverMessage).not.toHaveBeenCalled();
    });

    it('gate returns SUPPRESS → the run is kept in history, so a message it sent is stored', async () => {
      const toolCalls = [{ tool: 'send_message', input: '{}', output: '{}', success: true, timestamp: '2025-01-15T12:00:00Z' }];
      mockInvoke.mockResolvedValue({
        response: 'Posted the outage note to #ops.',
        toolCalls,
        steps: [{ text: 'Posted the outage note to #ops.', toolCalls }],
      });
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockDeliverMessage).not.toHaveBeenCalled();
      expect(mockInvoke).toHaveBeenCalledWith(expect.objectContaining({ mode: 'heartbeat', broadcastsOutput: true }));
      expect(mockKeepWithheldRun).toHaveBeenCalledWith({
        agentId: 'agent-1',
        userId: 'user-abc-123',
        content: 'Posted the outage note to #ops.',
        triggeredBy: 'HEARTBEAT',
        toolCalls,
      });
    });

    it('a suppressed channel-triggered run is kept in history too', async () => {
      mockPendingTriggerMessages.mockResolvedValueOnce([
        { sender: 'Test Operator', text: 'deploy failed', timestamp: '2025-01-15T12:00:00Z' },
      ]);
      mockInvoke.mockResolvedValue({
        response: 'Posted to #ops.',
        toolCalls: [],
        steps: [{ text: 'Posted to #ops.', toolCalls: [] }],
      });
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      heartbeatService.triggerFrom(triggerSource);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockKeepWithheldRun).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Posted to #ops.', triggeredBy: 'HEARTBEAT' }),
      );
    });

    it('gate returns DELIVER → message delivered', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Pod frontend-abc is in CrashLoopBackOff!',
        toolCalls: [],
        steps: [{ text: 'Pod frontend-abc is in CrashLoopBackOff!', toolCalls: [] }],
      });
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      const result = await heartbeatService.triggerHeartbeat();

      expect(result.shouldSkip).toBe(false);
      expect(result.text).toBe('Pod frontend-abc is in CrashLoopBackOff!');
      expect(mockDeliverMessage).toHaveBeenCalledWith(
        'agent-1',
        'user-abc-123',
        'Pod frontend-abc is in CrashLoopBackOff!',
        'HEARTBEAT',
        expect.objectContaining({ toolCalls: undefined }),
      );
    });

    it('gate call fails → fail-open, message delivered', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Pod frontend-abc is in CrashLoopBackOff!',
        toolCalls: [],
        steps: [{ text: 'Pod frontend-abc is in CrashLoopBackOff!', toolCalls: [] }],
      });
      mockGenerateText.mockRejectedValue(new Error('Bedrock timeout'));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      const result = await heartbeatService.triggerHeartbeat();

      expect(result.shouldSkip).toBe(false);
      expect(mockDeliverMessage).toHaveBeenCalled();
    });

    it('empty response → gate not called, suppressed', async () => {
      mockInvoke.mockResolvedValue({ response: '', toolCalls: [], steps: [] });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      const result = await heartbeatService.triggerHeartbeat();

      expect(result.shouldSkip).toBe(true);
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(mockDeliverMessage).not.toHaveBeenCalled();
    });

    it('exact duplicate → gate not called (isDuplicate catches it first)', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Pod crashing!',
        toolCalls: [],
        steps: [{ text: 'Pod crashing!', toolCalls: [] }],
      });
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');

      // First call — gate says DELIVER
      await heartbeatService.triggerHeartbeat();
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      mockGenerateText.mockClear();

      // Second call — exact same text, isDuplicate should catch it
      await heartbeatService.triggerHeartbeat();
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(mockDeliverMessage).toHaveBeenCalledTimes(1); // only from first call
    });

    it('gate receives last alert context in its prompt', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Pod frontend-abc is in CrashLoopBackOff!',
        toolCalls: [],
        steps: [{ text: 'Pod frontend-abc is in CrashLoopBackOff!', toolCalls: [] }],
      });
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');

      // First heartbeat — no previous alert
      await heartbeatService.triggerHeartbeat();
      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [expect.objectContaining({
            content: expect.stringContaining('No previous alert has been sent.'),
          })],
        }),
      );

      mockGenerateText.mockClear();
      // Change the response so isDuplicate doesn't catch it
      mockInvoke.mockResolvedValue({
        response: 'Pod frontend-abc still in CrashLoopBackOff, restarts: 15',
        toolCalls: [],
        steps: [{ text: 'Pod frontend-abc still in CrashLoopBackOff, restarts: 15', toolCalls: [] }],
      });

      // Second heartbeat — should include last alert context
      await heartbeatService.triggerHeartbeat();
      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [expect.objectContaining({
            content: expect.stringContaining('Last Alert Sent to User'),
          })],
        }),
      );
    });

    it('gate uses low maxOutputTokens and temperature 0', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Some alert',
        toolCalls: [],
        steps: [{ text: 'Some alert', toolCalls: [] }],
      });
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          // 16 = the OpenAI Responses API minimum; a cap, so free elsewhere.
          maxOutputTokens: 16,
          temperature: 0,
        }),
      );
    });

    it('gate prompt instructs suppression of heartbeat meta-commentary', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Heartbeat config is empty — no checks configured. Staying quiet.',
        toolCalls: [],
        steps: [{ text: 'Heartbeat config is empty — no checks configured. Staying quiet.', toolCalls: [] }],
      });
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining('talks about the heartbeat itself'),
        }),
      );
      expect(mockDeliverMessage).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Multi-step handling
  // ==========================================================================

  describe('multi-step handling', () => {
    beforeEach(() => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
    });

    it('delivers only the last step text as a single message', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Checking pods...\n\nPod frontend-abc is in CrashLoopBackOff!',
        toolCalls: [{ tool: 'kubectl', input: '{}', output: 'crash', success: true, timestamp: '2025-01-15T12:00:00Z' }],
        steps: [
          {
            text: 'Checking pods...',
            toolCalls: [{ tool: 'kubectl', input: '{}', output: 'crash', success: true, timestamp: '2025-01-15T12:00:00Z' }],
          },
          {
            text: 'Pod frontend-abc is in CrashLoopBackOff!',
            toolCalls: [],
          },
        ],
      });
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      // Should deliver exactly one message with the last step's text
      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);
      expect(mockDeliverMessage).toHaveBeenCalledWith(
        'agent-1',
        'user-abc-123',
        'Pod frontend-abc is in CrashLoopBackOff!',
        'HEARTBEAT',
        expect.objectContaining({
          toolCalls: expect.arrayContaining([expect.objectContaining({ tool: 'kubectl' })]),
        }),
      );
    });

    it.each(['timer', 'channel'])('%s delivers an alert before an empty final step', async (trigger) => {
      // A recorded e2e run wrote an alert with memory_write, then ended with an empty step.
      const alert = '**⚠️ ALERT: Production Deployment Failure**';
      mockInvoke.mockResolvedValue({
        response: `Checking the deployment.\n\n${alert}`,
        toolCalls: [],
        steps: [
          { text: 'Checking the deployment.', toolCalls: [] },
          { text: alert, toolCalls: [{ tool: 'memory_write' }] },
          { text: '', toolCalls: [] },
        ],
      });
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });
      heartbeatService.startHeartbeat(createAgent());

      if (trigger === 'channel') {
        mockPendingTriggerMessages.mockResolvedValueOnce([{
          sender: 'Test Operator', text: 'deployment failed', timestamp: '2025-01-15T12:00:00Z',
        }]);
        heartbeatService.triggerFrom(triggerSource);
        await vi.advanceTimersByTimeAsync(0);
      } else {
        await heartbeatService.triggerHeartbeat();
      }

      expect(mockGenerateText).toHaveBeenCalled();
      expect(mockDeliverMessage).toHaveBeenCalledExactlyOnceWith(
        'agent-1', 'user-abc-123', alert, 'HEARTBEAT', expect.anything(),
      );
    });

    it('passes all toolCalls from invokeResult (not per-step accumulated)', async () => {
      const toolCall1 = { tool: 'kubectl', input: '{}', output: 'pods', success: true, timestamp: '2025-01-15T12:00:00Z' };
      const toolCall2 = { tool: 'aws', input: '{}', output: 'ok', success: true, timestamp: '2025-01-15T12:00:01Z' };

      mockInvoke.mockResolvedValue({
        response: 'Summary',
        toolCalls: [toolCall1, toolCall2],
        steps: [
          { text: 'Step 1', toolCalls: [toolCall1] },
          { text: 'Summary', toolCalls: [toolCall2] },
        ],
      });
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockDeliverMessage).toHaveBeenCalledWith(
        'agent-1',
        'user-abc-123',
        'Summary',
        'HEARTBEAT',
        { toolCalls: [toolCall1, toolCall2] },
      );
    });

    it('uses empty responseText when there are no steps', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Something',
        toolCalls: [],
        steps: [],
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      const result = await heartbeatService.triggerHeartbeat();

      // Empty responseText means nothing to deliver
      expect(result.shouldSkip).toBe(true);
      expect(mockDeliverMessage).not.toHaveBeenCalled();
    });

    it('uses last step text even when intermediate steps have no text', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Full response',
        toolCalls: [{ tool: 'kubectl', input: '{}', output: 'ok', success: true, timestamp: '2025-01-15T12:00:00Z' }],
        steps: [
          { text: '', toolCalls: [{ tool: 'kubectl', input: '{}', output: 'ok', success: true, timestamp: '2025-01-15T12:00:00Z' }] },
          { text: 'Final summary', toolCalls: [] },
        ],
      });
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockDeliverMessage).toHaveBeenCalledWith(
        'agent-1',
        'user-abc-123',
        'Final summary',
        'HEARTBEAT',
        expect.anything(),
      );
    });
  });

  // ==========================================================================
  // Step logging
  // ==========================================================================

  describe('step logging', () => {
    beforeEach(() => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      mockLoggerInfo.mockClear();
      mockLoggerDebug.mockClear();
    });

    it('logs each step for timer-based heartbeat', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Summary',
        toolCalls: [],
        steps: [
          { text: 'Checking...', toolCalls: [{ tool: 'kubectl', input: '{}', output: 'ok', success: true, timestamp: '2025-01-15T12:00:00Z' }] },
          { text: 'All clear', toolCalls: [] },
        ],
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      const stepLogs = mockLoggerInfo.mock.calls
        .map((c: string[]) => c[0])
        .filter((msg: string) => msg.includes('step 1/2') || msg.includes('step 2/2'));
      expect(stepLogs).toHaveLength(2);
      expect(stepLogs[0]).toContain('tools=[kubectl]');
      expect(stepLogs[1]).toContain('text="All clear"');
    });

    it('logs each step for a channel-triggered heartbeat', async () => {
      mockPendingTriggerMessages.mockResolvedValueOnce([{
        sender: 'Alice',
        text: 'deploy failed',
        timestamp: '2025-01-15T12:00:00Z',
      }]);
      mockInvoke.mockResolvedValue({
        response: 'Investigating',
        toolCalls: [],
        steps: [
          { text: '', toolCalls: [{ tool: 'kubectl', input: '{}', output: 'pods', success: true, timestamp: '2025-01-15T12:00:00Z' }] },
          { text: 'Investigating', toolCalls: [] },
        ],
      });
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      heartbeatService.triggerFrom(triggerSource);
      await vi.advanceTimersByTimeAsync(0);

      const stepLogs = mockLoggerInfo.mock.calls
        .map((c: string[]) => c[0])
        .filter((msg: string) => msg.includes('slack-triggered step') && !msg.includes('LLM response'));
      expect(stepLogs).toHaveLength(2);
      expect(stepLogs[0]).toContain('tools=[kubectl]');
      expect(stepLogs[0]).toContain('(no text)');
      expect(stepLogs[1]).toContain('text="Investigating"');
    });

    it('logs summary line with step count for timer-based heartbeat', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Alert!',
        toolCalls: [],
        steps: [{ text: 'Alert!', toolCalls: [] }],
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      const summaryLogs = mockLoggerInfo.mock.calls
        .map((c: string[]) => c[0])
        .filter((msg: string) => msg.includes('LLM response') && msg.includes('1 step(s)'));
      expect(summaryLogs).toHaveLength(1);
      expect(summaryLogs[0]).toContain('Alert!');
    });
  });

  // ==========================================================================
  // Duplicate alert suppression
  // ==========================================================================

  describe('duplicate alert suppression', () => {
    beforeEach(() => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });
    });

    it('suppresses identical alerts within 24 hours', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Pod crashing!',
        toolCalls: [],
        steps: [{ text: 'Pod crashing!', toolCalls: [] }],
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');

      // First alert should be delivered
      await heartbeatService.triggerHeartbeat();
      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);

      mockDeliverMessage.mockClear();

      // Second identical alert within 24h should be suppressed (isDuplicate)
      await heartbeatService.triggerHeartbeat();
      expect(mockDeliverMessage).not.toHaveBeenCalled();
    });

    it('delivers alert again after 24 hours have passed', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Pod crashing!',
        toolCalls: [],
        steps: [{ text: 'Pod crashing!', toolCalls: [] }],
      });

      // Use a very long interval so the timer does not fire during time advance
      heartbeatService.startHeartbeat(
        createAgent({ heartbeatIntervalMs: 100 * 60 * 60 * 1000 }),
        'keep-schedule',
      );

      // First alert
      await heartbeatService.triggerHeartbeat();
      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);
      mockDeliverMessage.mockClear();

      // Advance time past 24 hours (the interval won't fire because it's 100h)
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      // Same alert should now be delivered again since >24h passed
      await heartbeatService.triggerHeartbeat();
      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);
    });

    it('delivers different alerts even within 24 hours', async () => {
      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');

      mockInvoke.mockResolvedValue({ response: 'Alert A', toolCalls: [], steps: [{ text: 'Alert A', toolCalls: [] }] });
      await heartbeatService.triggerHeartbeat();

      mockInvoke.mockResolvedValue({ response: 'Alert B', toolCalls: [], steps: [{ text: 'Alert B', toolCalls: [] }] });
      await heartbeatService.triggerHeartbeat();

      expect(mockDeliverMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('a check a restart interrupts', () => {
    beforeEach(() => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });
    });

    it('moves the schedule only after the alert is delivered', async () => {
      mockInvoke.mockResolvedValue({ response: 'Disk full', toolCalls: [], steps: [{ text: 'Disk full', toolCalls: [] }] });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      const ran = mockUpdateHeartbeatSchedule.mock.calls.findIndex(
        (call) => (call[0] as ScheduleWrite).lastHeartbeat,
      );
      expect(mockDeliverMessage.mock.invocationCallOrder[0]).toBeLessThan(
        mockUpdateHeartbeatSchedule.mock.invocationCallOrder[ran],
      );
    });

    it('stays due when a shutdown stops it, and delivers nothing', async () => {
      mockInvoke.mockImplementation(async () => {
        shutdown.controller.abort();
        return { response: 'Disk full', toolCalls: [], steps: [{ text: 'Disk full', toolCalls: [] }] };
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockDeliverMessage).not.toHaveBeenCalled();
      expect(mockUpdateHeartbeatSchedule).not.toHaveBeenCalledWith(
        expect.objectContaining({ lastHeartbeat: expect.any(Date) }),
      );
    });

    it('ends the cycle when a shutdown starts once the delivery is under way', async () => {
      // The delivery may have reached a channel, so the next boot must not run
      // the check again and send the alert twice.
      mockInvoke.mockResolvedValue({ response: 'Disk full', toolCalls: [], steps: [{ text: 'Disk full', toolCalls: [] }] });
      mockDeliverMessage.mockImplementationOnce(async () => {
        shutdown.controller.abort();
        throw new Error('socket closed');
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockUpdateHeartbeatSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ lastHeartbeat: expect.any(Date) }),
      );
    });

    it('suppresses the alert the last process delivered, after a restart', async () => {
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      mockFindLastAlert.mockResolvedValue([
        { content: 'Pod crashing!', createdAt: new Date('2025-01-15T11:58:00Z'), toolCalls: null },
      ]);
      mockInvoke.mockResolvedValue({
        response: 'Pod crashing!',
        toolCalls: [],
        steps: [{ text: 'Pod crashing!', toolCalls: [] }],
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();

      expect(mockDeliverMessage).not.toHaveBeenCalled();
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it('restores the last delivered alert, not a newer withheld record of a run that sent, after a restart', async () => {
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });
      const send = { tool: 'send_message', input: JSON.stringify({ target: '#ops', text: 'Build #812 failed.' }), output: '{}', success: true, timestamp: '2025-01-15T11:59:00Z' };
      mockFindLastAlert.mockResolvedValue([
        { content: "This heartbeat check stopped: your organization's AI spending limit has been reached.", createdAt: new Date('2025-01-15T11:59:00Z'), toolCalls: [send] },
        { content: 'Build #812 is failing.', createdAt: new Date('2025-01-15T11:58:00Z'), toolCalls: null },
      ]);
      mockInvoke.mockResolvedValue({
        response: 'Build #812 is failing.',
        toolCalls: [],
        steps: [{ text: 'Build #812 is failing.', toolCalls: [] }],
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatService.triggerHeartbeat();

      // The restored baseline is the delivered alert, so the repeat is a duplicate.
      expect(mockDeliverMessage).not.toHaveBeenCalled();
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("reads the last alert from web threads only, not a send's copy in its target's thread", async () => {
      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFindLastAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ thread: { agentId: 'agent-1', externalThreadId: null } }),
        }),
      );
    });
  });

  // ==========================================================================
  // Consecutive error handling
  // ==========================================================================

  describe('consecutive error handling', () => {
    beforeEach(() => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
    });

    it('increments consecutiveErrors on failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Network failure'));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      const status = heartbeatService.getStatus();
      expect(status?.consecutiveErrors).toBe(1);
    });

    it('auto-stops heartbeat after 5 consecutive errors', async () => {
      mockInvoke.mockRejectedValue(new Error('Network failure'));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');

      for (let i = 0; i < 5; i++) {
        await heartbeatService.triggerHeartbeat();
      }

      // Should have been stopped
      expect(heartbeatService.getStatus()).toBe(null);
    });

    it('does not stop heartbeat before reaching 5 consecutive errors', async () => {
      mockInvoke.mockRejectedValue(new Error('Network failure'));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');

      for (let i = 0; i < 4; i++) {
        await heartbeatService.triggerHeartbeat();
      }

      expect(heartbeatService.getStatus()).not.toBe(null);
      expect(heartbeatService.getStatus()?.consecutiveErrors).toBe(4);
    });

    it('returns error message as skipped result on failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Connection refused'));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      const result = await heartbeatService.triggerHeartbeat();

      expect(result).toEqual({
        shouldSkip: true,
        text: 'Connection refused',
      });
    });

    it('resets consecutiveErrors on a successful run after failures', async () => {
      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');

      // First: 2 failures
      mockInvoke.mockRejectedValue(new Error('fail'));
      await heartbeatService.triggerHeartbeat();
      await heartbeatService.triggerHeartbeat();
      expect(heartbeatService.getStatus()?.consecutiveErrors).toBe(2);

      // Then: success (gate suppresses, but errors still reset)
      mockInvoke.mockResolvedValue({ response: 'All systems healthy.', toolCalls: [], steps: [] });
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
      await heartbeatService.triggerHeartbeat();

      expect(heartbeatService.getStatus()?.consecutiveErrors).toBe(0);
    });
  });

  // ==========================================================================
  // Heartbeat prompt building
  // ==========================================================================

  describe('heartbeat prompt building', () => {
    beforeEach(() => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
    });

    it('uses a single minimal prompt regardless of vision', async () => {
      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockInvoke).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('Perform your heartbeat check now'),
        }),
      );
      // Should not contain old phase-based prompts
      expect(mockInvoke).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.not.stringContaining('THINK'),
        }),
      );
    });
  });

  // ==========================================================================
  // Interval timer behavior
  // ==========================================================================

  describe('interval timer', () => {
    const NOW = new Date('2025-01-15T12:00:00Z');
    const HOUR = 60 * 60 * 1000;
    const EIGHT_HOURS = 8 * HOUR;

    beforeEach(() => {
      vi.setSystemTime(NOW);
    });

    it('executes heartbeat on each interval tick', async () => {
      heartbeatService.startHeartbeat(createAgent({ heartbeatIntervalMs: 60_000 }), 'keep-schedule');

      // Each tick arms the next one, so repetition is this service's own
      // invariant rather than the platform's.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockInvoke).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockInvoke).toHaveBeenCalledTimes(3);
    });

    it('runs the remainder of the interval after a restart', async () => {
      heartbeatService.startHeartbeat(
        createAgent({ lastHeartbeat: new Date(NOW.getTime() - 5 * HOUR) }),
        'keep-schedule',
      );

      await vi.advanceTimersByTimeAsync(3 * HOUR - 1000);
      expect(mockInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('runs an overdue heartbeat one minute after a restart', async () => {
      heartbeatService.startHeartbeat(
        createAgent({ lastHeartbeat: new Date(NOW.getTime() - 9 * HOUR) }),
        'keep-schedule',
      );

      await vi.advanceTimersByTimeAsync(59_000);
      expect(mockInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('waits a full interval for an agent that has never run', async () => {
      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');

      // Nothing runs at registration.
      expect(mockInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(EIGHT_HOURS - 1000);
      expect(mockInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('keeps the due time across a re-registration', async () => {
      const agent = createAgent({ lastHeartbeat: new Date(NOW.getTime() - 7 * HOUR) });
      heartbeatService.startHeartbeat(agent, 'keep-schedule');

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      heartbeatService.startHeartbeat(agent, 'keep-schedule');

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1000);
      expect(mockInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('starts a fresh interval when the cadence changes', async () => {
      const agent = createAgent();
      heartbeatService.startHeartbeat(agent, 'keep-schedule');

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      heartbeatService.startHeartbeat(
        { ...agent, heartbeatIntervalMs: 2 * HOUR } as AgentWorkspace,
        'new-interval',
      );

      await vi.advanceTimersByTimeAsync(2 * HOUR - 1000);
      expect(mockInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('keeps a changed cadence across a restart', async () => {
      // 05:00, on the eight-hour cadence.
      const lastHeartbeat = new Date(NOW.getTime() - 7 * HOUR);
      const agent = createAgent({ lastHeartbeat });
      heartbeatService.startHeartbeat(agent, 'keep-schedule');

      // 12:00 — the user shortens the cadence to two hours, so the next check
      // is due at 14:00.
      const shortened = createAgent({ lastHeartbeat, heartbeatIntervalMs: 2 * HOUR });
      heartbeatService.startHeartbeat(shortened, 'new-interval');

      // 12:10 — the process stops and boots again from the persisted row.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      heartbeatService.stopAll();
      heartbeatService.startHeartbeat(persistedRow(shortened), 'keep-schedule');

      // Not at 12:11, which is where the delay floor would put a check the boot
      // read as overdue.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockInvoke).not.toHaveBeenCalled();

      // And not late either: still 14:00, as the running process had it.
      await vi.advanceTimersByTimeAsync(2 * HOUR - 10 * 60_000 - 60_000 - 1000);
      expect(mockInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('persists the deadline a cadence change sets, and no run with it', () => {
      const lastHeartbeat = new Date(NOW.getTime() - 7 * HOUR);
      heartbeatService.startHeartbeat(
        createAgent({ lastHeartbeat, heartbeatIntervalMs: 2 * HOUR }),
        'new-interval',
      );

      expect(mockUpdateHeartbeatSchedule).toHaveBeenCalledWith({
        nextHeartbeatAt: new Date(NOW.getTime() + 2 * HOUR),
      });
      // No lastHeartbeat in that write: nothing ran, so the row must keep
      // reporting 05:00 as the last check.
      expect(mockUpdateHeartbeatSchedule.mock.calls[0][0]).not.toHaveProperty('lastHeartbeat');
    });

    it('keeps an unchanged cadence across a restart', async () => {
      const agent = createAgent({ lastHeartbeat: new Date(NOW.getTime() - 5 * HOUR) });
      heartbeatService.startHeartbeat(agent, 'keep-schedule');

      // A restart that changes nothing leaves the check at 20:00, three hours out.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      heartbeatService.stopAll();
      heartbeatService.startHeartbeat(persistedRow(agent), 'keep-schedule');

      await vi.advanceTimersByTimeAsync(3 * HOUR - 10 * 60_000 - 1000);
      expect(mockInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('keeps the deadline a completed run set across a restart', async () => {
      const agent = createAgent({ heartbeatIntervalMs: 2 * HOUR });
      heartbeatService.startHeartbeat(agent, 'keep-schedule');

      // The run at 14:00 puts the next check at 16:00.
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(mockInvoke).toHaveBeenCalledTimes(1);

      heartbeatService.stopAll();
      heartbeatService.startHeartbeat(persistedRow(agent), 'keep-schedule');

      await vi.advanceTimersByTimeAsync(2 * HOUR - 1000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    it('takes the deadline off the last run for a row that carries no deadline', async () => {
      // What a database written before the deadline column holds.
      heartbeatService.startHeartbeat(
        createAgent({ lastHeartbeat: new Date(NOW.getTime() - 5 * HOUR), nextHeartbeatAt: null }),
        'keep-schedule',
      );

      await vi.advanceTimersByTimeAsync(3 * HOUR - 1000);
      expect(mockInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('trims a deadline left behind by a cadence change made while stopped', async () => {
      // A stopped heartbeat arms no timer, so it writes no deadline, and the row
      // keeps the one the last run set: 20:00, on the eight-hour cadence. The
      // user then shortens the cadence to an hour and starts the heartbeat.
      const stopped = createAgent({
        lastHeartbeat: NOW,
        nextHeartbeatAt: new Date(NOW.getTime() + EIGHT_HOURS),
        heartbeatIntervalMs: HOUR,
      });
      heartbeatService.startHeartbeat(stopped, 'keep-schedule');

      // 13:00, one interval out — not the 20:00 the row still holds.
      await vi.advanceTimersByTimeAsync(HOUR - 1000);
      expect(mockInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('runs an overdue check one minute after a restart with no deadline stored', async () => {
      heartbeatService.startHeartbeat(
        createAgent({ lastHeartbeat: new Date(NOW.getTime() - 9 * HOUR), nextHeartbeatAt: null }),
        'keep-schedule',
      );

      await vi.advanceTimersByTimeAsync(59_000);
      expect(mockInvoke).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('reports the persisted last run as soon as it is registered', () => {
      const lastHeartbeat = new Date(NOW.getTime() - 2 * HOUR);
      heartbeatService.startHeartbeat(createAgent({ lastHeartbeat }), 'keep-schedule');

      expect(heartbeatService.getStatus()?.lastRun).toEqual(lastHeartbeat);
    });

    it('spaces the next cycle a full interval after a budget-exceeded skip', async () => {
      mockInvoke.mockResolvedValue({
        response: '',
        toolCalls: [],
        steps: [],
        error: { type: 'budget_exceeded', detail: 'spending limit reached' },
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');

      await vi.advanceTimersByTimeAsync(EIGHT_HOURS);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockUpdateHeartbeatSchedule).toHaveBeenCalledTimes(1);

      // A recorded cycle, so the retry is an interval away rather than a minute.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(EIGHT_HOURS);
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    it('spaces the next cycle a full interval after a failed run', async () => {
      mockInvoke.mockRejectedValue(new Error('Network failure'));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');

      await vi.advanceTimersByTimeAsync(EIGHT_HOURS);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockUpdateHeartbeatSchedule).toHaveBeenCalledTimes(1);

      // The error streak keeps its interval spacing, so the auto-stop after five
      // failures still takes five intervals rather than five minutes.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(EIGHT_HOURS);
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    it('records no cycle for a tick that lands inside a run', async () => {
      let resolveInvoke!: (v: unknown) => void;
      mockInvoke.mockReturnValue(new Promise((r) => { resolveInvoke = r; }));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      const firstRun = heartbeatService.triggerHeartbeat();

      // The timer fires while that run is still in flight.
      await vi.advanceTimersByTimeAsync(EIGHT_HOURS);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockUpdateHeartbeatSchedule).not.toHaveBeenCalled();

      resolveInvoke({ response: 'All systems healthy.', toolCalls: [], steps: [] });
      await firstRun;
      expect(mockUpdateHeartbeatSchedule).toHaveBeenCalledTimes(1);

      // The completed run recorded the cycle, so the retry waits a full interval.
      mockInvoke.mockResolvedValue({ response: 'All systems healthy.', toolCalls: [], steps: [] });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(EIGHT_HOURS);
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    it('re-registering during a run adds no second run and keeps the alert history', async () => {
      let resolveInvoke!: (v: unknown) => void;
      mockInvoke.mockReturnValue(new Promise((r) => { resolveInvoke = r; }));
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      const agent = createAgent();
      heartbeatService.startHeartbeat(agent, 'keep-schedule');
      const firstRun = heartbeatService.triggerHeartbeat();

      heartbeatService.startHeartbeat(agent, 'keep-schedule');

      resolveInvoke({
        response: 'Pod crashing!',
        toolCalls: [],
        steps: [{ text: 'Pod crashing!', toolCalls: [] }],
      });
      await firstRun;
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockDeliverMessage).toHaveBeenCalledTimes(1);

      // The alert history survived the re-registration, so the same text is
      // still a duplicate.
      mockInvoke.mockResolvedValue({
        response: 'Pod crashing!',
        toolCalls: [],
        steps: [{ text: 'Pod crashing!', toolCalls: [] }],
      });
      mockDeliverMessage.mockClear();
      await heartbeatService.triggerHeartbeat();

      expect(mockDeliverMessage).not.toHaveBeenCalled();
    });

    it('re-arms after a cycle that throws out of the run', async () => {
      mockInvoke.mockRejectedValue(new Error('Network failure'));
      // The error path's own telemetry throws, which is the one way a cycle can
      // escape the run. The chain must survive it, and the rejection must not
      // reach the timer callback, where it would end the process.
      mockTrackEvent.mockImplementation((name: string) => {
        if (name === 'heartbeat completed') throw new Error('collector unreachable');
      });

      heartbeatService.startHeartbeat(createAgent({ heartbeatIntervalMs: 60_000 }), 'keep-schedule');

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('Cycle failed outside the run'),
      );

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    it('does not re-arm after a stop', async () => {
      heartbeatService.startHeartbeat(createAgent({ heartbeatIntervalMs: 60_000 }), 'keep-schedule');

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);

      heartbeatService.stopHeartbeat();

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Channel-triggered heartbeat (triggerFrom)
  // ==========================================================================

  describe('triggerFrom', () => {
    const channelMsg = (text: string) => ({
      sender: 'Alice',
      text,
      timestamp: '2025-01-15T12:00:00Z',
    });

    beforeEach(() => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });
    });

    it('returns ignored when agent has no heartbeat state', () => {
      const status = heartbeatService.triggerFrom(triggerSource);
      expect(status).toBe('ignored');
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('a timer heartbeat reads every source so nothing queued waits', async () => {
      mockPendingTriggerMessages.mockResolvedValueOnce([channelMsg('disk at 95%')]);
      mockInvoke.mockResolvedValue({
        response: 'Disk alert',
        toolCalls: [],
        steps: [{ text: 'Disk alert', toolCalls: [] }],
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockPendingTriggerMessages).toHaveBeenCalledWith('agent-1');
      expect(mockInvoke).toHaveBeenCalledWith(
        expect.objectContaining({
          heartbeatTriggers: [{ platform: 'Slack', messages: [channelMsg('disk at 95%')] }],
        }),
      );
    });

    it('reads messages from DB and passes them into invoke', async () => {
      mockPendingTriggerMessages.mockResolvedValueOnce([channelMsg('deploy failed')]);
      mockInvoke.mockResolvedValue({
        response: 'Incident detected!',
        toolCalls: [],
        steps: [{ text: 'Incident detected!', toolCalls: [] }],
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      heartbeatService.triggerFrom(triggerSource);

      // Let the fire-and-forget promise resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(mockPendingTriggerMessages).toHaveBeenCalledWith('agent-1');
      expect(mockInvoke).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-abc-123',
          mode: 'heartbeat',
          heartbeatTriggers: [{ platform: 'Slack', messages: [channelMsg('deploy failed')] }],
          prompt: 'Perform your heartbeat check now. This heartbeat was triggered by new messages in the monitored Slack channel.',
        }),
      );
    });

    it('returns ignored when heartbeat is already running (throttle queue handles next trigger)', async () => {
      let resolveFirst!: (v: unknown) => void;
      mockInvoke.mockReturnValueOnce(new Promise(r => { resolveFirst = r; }));
      mockPendingTriggerMessages.mockResolvedValueOnce([channelMsg('msg-1')]);

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');

      // First trigger starts execution
      heartbeatService.triggerFrom(triggerSource);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke).toHaveBeenCalledTimes(1);

      // Second trigger while first is running — returns ignored
      const status = heartbeatService.triggerFrom(triggerSource);
      expect(status).toBe('ignored');

      // Resolve the first invoke — no re-trigger happens
      resolveFirst({
        response: 'First alert',
        toolCalls: [],
        steps: [{ text: 'First alert', toolCalls: [] }],
      });
      await vi.advanceTimersByTimeAsync(0);

      // Only the first invoke was called
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    describe('a restart at any moment', () => {
      it('removes the messages a run read once the run has ended, after its delivery', async () => {
        mockPendingTriggerMessages.mockResolvedValueOnce([channelMsg('prod is down')]);
        mockInvoke.mockResolvedValue({
          response: 'Incident in prod!',
          toolCalls: [],
          steps: [{ text: 'Incident in prod!', toolCalls: [] }],
        });

        heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
        heartbeatService.triggerFrom(triggerSource);
        await vi.advanceTimersByTimeAsync(0);

        expect(mockRemoveTriggerMessages).toHaveBeenCalledWith(['pending-0']);
        expect(mockDeliverMessage.mock.invocationCallOrder[0]).toBeLessThan(
          mockRemoveTriggerMessages.mock.invocationCallOrder[0],
        );
      });

      it('keeps the messages when a shutdown stops the run, and delivers nothing', async () => {
        mockPendingTriggerMessages.mockResolvedValueOnce([channelMsg('prod is down')]);
        mockInvoke.mockImplementation(async () => {
          shutdown.controller.abort();
          return { response: 'Incident', toolCalls: [], steps: [{ text: 'Incident', toolCalls: [] }] };
        });

        heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
        heartbeatService.triggerFrom(triggerSource);
        await vi.advanceTimersByTimeAsync(0);

        expect(mockDeliverMessage).not.toHaveBeenCalled();
        expect(mockRemoveTriggerMessages).not.toHaveBeenCalled();
        // The row stays, so the next boot counts the run it starts again.
        expect(mockFinishWork).not.toHaveBeenCalled();
      });

      it('keeps a run as pending work from before the model call until its messages are removed', async () => {
        mockPendingTriggerMessages.mockResolvedValueOnce([channelMsg('prod is down')]);
        mockInvoke.mockResolvedValue({ response: 'On it.', toolCalls: [], steps: [{ text: 'On it.', toolCalls: [] }] });

        heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
        heartbeatService.triggerFrom(triggerSource);
        await vi.advanceTimersByTimeAsync(0);

        expect(mockBeginWork).toHaveBeenCalledWith('heartbeat', 'agent-1', { read: { slack: ['pending-0'] } });
        expect(mockBeginWork.mock.invocationCallOrder[0]).toBeLessThan(mockInvoke.mock.invocationCallOrder[0]);
        expect(mockFinishWork).toHaveBeenCalledWith('heartbeat', 'agent-1');
        expect(mockRemoveTriggerMessages.mock.invocationCallOrder[0]).toBeLessThan(
          mockFinishWork.mock.invocationCallOrder[0],
        );
      });

      it('gives up a run that stopped the runtime on every boot: its messages go, and the check waits an interval', async () => {
        vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
        await heartbeatService.resume([], [
          { key: 'agent-1', payload: { read: { slack: ['pending-0'] } }, attempts: 4, createdAt: new Date() },
        ]);
        expect(mockRemoveTriggerMessages).toHaveBeenCalledWith(['pending-0']);

        // Overdue by an hour, which would run a minute after the boot.
        heartbeatService.startHeartbeat(
          createAgent({ lastHeartbeat: new Date('2025-01-15T03:00:00Z') }),
          'keep-schedule',
        );
        await vi.advanceTimersByTimeAsync(60_000);

        expect(mockInvoke).not.toHaveBeenCalled();
        expect(mockUpdateHeartbeatSchedule).toHaveBeenCalledWith({ nextHeartbeatAt: new Date('2025-01-15T20:00:00Z') });
      });

      it('answers the messages a restart left behind, at boot', async () => {
        mockPendingTriggerMessages.mockResolvedValue([channelMsg('still waiting')]);
        mockInvoke.mockResolvedValue({ response: 'On it.', toolCalls: [], steps: [{ text: 'On it.', toolCalls: [] }] });

        heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
        await heartbeatService.answerPendingTriggers();
        await vi.advanceTimersByTimeAsync(0);

        expect(mockInvoke).toHaveBeenCalledWith(
          expect.objectContaining({
            heartbeatTriggers: [{ platform: 'Slack', messages: [channelMsg('still waiting')] }],
          }),
        );
      });

      it('starts no run at boot when no message waits', async () => {
        heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
        await heartbeatService.answerPendingTriggers();
        await vi.advanceTimersByTimeAsync(0);

        expect(mockInvoke).not.toHaveBeenCalled();
      });
    });

    it('delivers the response when gate says DELIVER', async () => {
      mockPendingTriggerMessages.mockResolvedValueOnce([channelMsg('prod is down')]);
      mockInvoke.mockResolvedValue({
        response: 'Incident in prod!',
        toolCalls: [],
        steps: [{ text: 'Incident in prod!', toolCalls: [] }],
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      heartbeatService.triggerFrom(triggerSource);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDeliverMessage).toHaveBeenCalledWith(
        'agent-1',
        'user-abc-123',
        'Incident in prod!',
        'HEARTBEAT',
        expect.anything(),
      );
    });

    it('resets isRunning after completion', async () => {
      mockPendingTriggerMessages.mockResolvedValueOnce([channelMsg('check')]);
      mockInvoke.mockResolvedValue({
        response: 'All good',
        toolCalls: [],
        steps: [],
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      heartbeatService.triggerFrom(triggerSource);
      await vi.advanceTimersByTimeAsync(0);

      expect(heartbeatService.getStatus()?.isRunning).toBe(false);
    });
  });

  // ==========================================================================
  // Telemetry
  // ==========================================================================

  describe('telemetry', () => {
    beforeEach(() => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
    });

    it('emits "heartbeat started" with the interval on start', () => {
      heartbeatService.startHeartbeat(createAgent({ heartbeatIntervalMs: 60_000 }), 'keep-schedule');

      expect(mockTrackEvent).toHaveBeenCalledWith('heartbeat started', 'user-abc-123', {
        'agent.id': 'agent-1',
        'heartbeat.interval_ms': '60000',
      });
    });

    it('does not emit "heartbeat started" when status is STOPPED', () => {
      heartbeatService.startHeartbeat(createAgent({ heartbeatStatus: 'STOPPED' }), 'keep-schedule');

      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('emits "heartbeat stopped" on stop', () => {
      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      mockTrackEvent.mockClear();

      heartbeatService.stopHeartbeat();

      expect(mockTrackEvent).toHaveBeenCalledWith('heartbeat stopped', 'user-abc-123', {
        'agent.id': 'agent-1',
      });
    });

    it('does not emit "heartbeat stopped" when no heartbeat was running', () => {
      heartbeatService.stopHeartbeat();

      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('emits "heartbeat completed" with result=delivered when the gate delivers', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Alert!',
        toolCalls: [],
        steps: [{ text: 'Alert!', toolCalls: [] }],
      });
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockTrackEvent).toHaveBeenCalledWith('heartbeat completed', 'user-abc-123', {
        'agent.id': 'agent-1',
        'heartbeat.trigger': 'timer',
        'heartbeat.result': 'delivered',
        'heartbeat.duration_ms': expect.any(String),
      });
    });

    it('emits "heartbeat completed" with result=suppressed when the gate suppresses', async () => {
      mockInvoke.mockResolvedValue({
        response: 'All clear.',
        toolCalls: [],
        steps: [{ text: 'All clear.', toolCalls: [] }],
      });
      mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'heartbeat completed',
        'user-abc-123',
        expect.objectContaining({ 'heartbeat.result': 'suppressed' }),
      );
    });

    it('emits "heartbeat completed" with result=budget_exceeded', async () => {
      mockInvoke.mockResolvedValue({
        response: '',
        toolCalls: [],
        steps: [],
        error: { type: 'budget_exceeded', detail: null },
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'heartbeat completed',
        'user-abc-123',
        expect.objectContaining({ 'heartbeat.result': 'budget_exceeded' }),
      );
    });

    it('keeps a run that hit the spending limit in history, so a message it sent is stored', async () => {
      const toolCalls = [{ tool: 'send_message', input: '{}', output: '{}', success: true, timestamp: '2025-01-15T12:00:00Z' }];
      mockInvoke.mockResolvedValue({
        response: '',
        toolCalls,
        steps: [],
        error: { type: 'budget_exceeded', detail: null },
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockKeepWithheldRun).toHaveBeenCalledWith({
        agentId: 'agent-1',
        userId: 'user-abc-123',
        content: "This heartbeat check stopped: your organization's AI spending limit has been reached.",
        triggeredBy: 'HEARTBEAT',
        toolCalls,
      });
      expect(mockDeliverMessage).not.toHaveBeenCalled();
    });

    it('keeps a channel-triggered run that hit the spending limit in history, with the budget notice as its text', async () => {
      const toolCalls = [{ tool: 'send_message', input: '{}', output: '{}', success: true, timestamp: '2025-01-15T12:00:00Z' }];
      mockPendingTriggerMessages.mockResolvedValueOnce([
        { sender: 'Test Operator', text: 'deploy failed', timestamp: '2025-01-15T12:00:00Z' },
      ]);
      mockInvoke.mockResolvedValue({
        response: '',
        toolCalls,
        steps: [],
        error: { type: 'budget_exceeded', detail: null },
      });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      heartbeatService.triggerFrom(triggerSource);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockKeepWithheldRun).toHaveBeenCalledWith({
        agentId: 'agent-1',
        userId: 'user-abc-123',
        content: "This heartbeat check stopped: your organization's AI spending limit has been reached.",
        triggeredBy: 'HEARTBEAT',
        toolCalls,
      });
    });

    it('emits "heartbeat completed" with result=error when invoke throws', async () => {
      mockInvoke.mockRejectedValue(new Error('Network failure'));

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      await heartbeatService.triggerHeartbeat();

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'heartbeat completed',
        'user-abc-123',
        expect.objectContaining({ 'heartbeat.trigger': 'timer', 'heartbeat.result': 'error' }),
      );
    });

    it('tags channel-triggered runs with the channel as the trigger', async () => {
      mockPendingTriggerMessages.mockResolvedValueOnce([
        { sender: 'Alice', text: 'deploy failed', timestamp: '2025-01-15T12:00:00Z' },
      ]);
      mockInvoke.mockResolvedValue({
        response: 'Incident!',
        toolCalls: [],
        steps: [{ text: 'Incident!', toolCalls: [] }],
      });
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      heartbeatService.startHeartbeat(createAgent(), 'keep-schedule');
      heartbeatService.triggerFrom(triggerSource);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'heartbeat completed',
        'user-abc-123',
        expect.objectContaining({ 'heartbeat.trigger': 'slack', 'heartbeat.result': 'delivered' }),
      );
    });
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  describe('edge cases', () => {
    it('executeHeartbeat returns skipped when agent has no registered heartbeat', async () => {
      const result = await heartbeatService.triggerHeartbeat();

      expect(result).toEqual({ shouldSkip: true, text: 'No registered heartbeat for this agent' });
      expect(mockInvoke).not.toHaveBeenCalled();
    });

  });
});
