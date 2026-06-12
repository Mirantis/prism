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
  mockUpdateHeartbeatTimestamp,
  mockUpdateAgentHeartbeatStatus,
  mockDrainSlackMessages,
  mockGenerateText,
  mockGetClassificationModel,
  mockLoggerInfo,
  mockLoggerDebug,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockDeliverMessage: vi.fn(),
  mockUpdateHeartbeatTimestamp: vi.fn(),
  mockUpdateAgentHeartbeatStatus: vi.fn(),
  mockDrainSlackMessages: vi.fn(),
  mockGenerateText: vi.fn(),
  mockGetClassificationModel: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerDebug: vi.fn(),
}));

vi.mock('../invoke', () => ({
  invoke: mockInvoke,
}));

vi.mock('./message-delivery.service', () => ({
  messageDeliveryService: {
    publishToActiveThread: mockDeliverMessage,
  },
}));

vi.mock('./slack-message-queue.service', () => ({
  slackMessageQueueService: {
    drain: mockDrainSlackMessages,
  },
}));

vi.mock('./agent-status.service', () => ({
  agentStatusService: {
    updateHeartbeatTimestamp: mockUpdateHeartbeatTimestamp,
    updateAgentHeartbeatStatus: mockUpdateAgentHeartbeatStatus,
  },
}));

vi.mock('ai', () => ({
  generateText: mockGenerateText,
}));

vi.mock('../lib/classification', () => ({
  getClassificationModel: mockGetClassificationModel,
}));

const { mockTrackEvent } = vi.hoisted(() => ({ mockTrackEvent: vi.fn() }));

vi.mock('../lib/telemetry', () => ({
  trackEvent: mockTrackEvent,
}));

vi.mock('../logger', () => ({
  logger: {
    info: mockLoggerInfo,
    debug: mockLoggerDebug,
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { heartbeatService } from './heartbeat.service';
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
    proactivity: 3,
    verbosity: 3,
    timezone: 'UTC',
    model: null,
    dailyResetHour: 4,
    idleTimeoutMins: null,
    status: 'IDLE' as const,
    lastHeartbeat: null,
    currentSessionId: null,
    nexusMcpAgentToken: null,
    nexusAgentTokenId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as AgentWorkspace;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HeartbeatService', () => {
  beforeEach(() => {
    vi.useFakeTimers();

    // Default: gate suppresses (most tests override this)
    mockGenerateText.mockResolvedValue({ text: 'SUPPRESS' });
    mockGetClassificationModel.mockReturnValue('classification-model');
    // Sensible defaults
    mockInvoke.mockResolvedValue({ response: 'All systems healthy.', toolCalls: [], steps: [] });
    mockUpdateHeartbeatTimestamp.mockResolvedValue(undefined);
    mockUpdateAgentHeartbeatStatus.mockResolvedValue(undefined);
    mockDeliverMessage.mockResolvedValue({ messageId: 'msg-1', threadId: 'thr-1' });
    mockDrainSlackMessages.mockResolvedValue([]);
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
      heartbeatService.startHeartbeat(agent);

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
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const agent = createAgent({ heartbeatIntervalMs: 0 });
      heartbeatService.startHeartbeat(agent);

      // Verify setInterval was called with the 8-hour default (28,800,000ms)
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 28_800_000);
      setIntervalSpy.mockRestore();

      // Should NOT fire at 1 minute (old default)
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockInvoke).not.toHaveBeenCalled();

      // SHOULD fire at 8 hours
      await vi.advanceTimersByTimeAsync(28_800_000 - 60_000);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('skips starting when agent has heartbeatStatus STOPPED', () => {
      const agent = createAgent({ heartbeatStatus: 'STOPPED' });
      heartbeatService.startHeartbeat(agent);

      expect(mockUpdateAgentHeartbeatStatus).not.toHaveBeenCalled();
    });

    it('persists ENABLED status to backend when starting', () => {
      heartbeatService.startHeartbeat(createAgent());

      expect(mockUpdateAgentHeartbeatStatus).toHaveBeenCalledWith('ENABLED');
    });

    it('stops existing heartbeat before starting a new one (no duplicates)', () => {
      const agent = createAgent();
      heartbeatService.startHeartbeat(agent);
      heartbeatService.startHeartbeat(agent);
    });
  });

  describe('stopHeartbeat', () => {
    it('removes the agent from active heartbeats', () => {
      heartbeatService.startHeartbeat(createAgent());
      heartbeatService.stopHeartbeat();

      expect(heartbeatService.getStatus()).toBeNull();
    });

    it('persists STOPPED status to backend when stopping', () => {
      heartbeatService.startHeartbeat(createAgent());
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
      heartbeatService.startHeartbeat(createAgent({ id: 'agent-a', userId: 'user-1' }));
      heartbeatService.startHeartbeat(createAgent({ id: 'agent-b', userId: 'user-2' }));

      heartbeatService.stopAll();
    });

    it('does not persist STOPPED status (graceful shutdown should not corrupt state)', () => {
      heartbeatService.startHeartbeat(createAgent({ id: 'agent-a', userId: 'user-1' }));
      heartbeatService.startHeartbeat(createAgent({ id: 'agent-b', userId: 'user-2' }));
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
      heartbeatService.startHeartbeat(createAgent());

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
      heartbeatService.startHeartbeat(createAgent());

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

      heartbeatService.startHeartbeat(createAgent());
      await heartbeatService.triggerHeartbeat();

      expect(mockInvoke).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-abc-123',
          mode: 'heartbeat',
        }),
      );
      expect(mockUpdateHeartbeatTimestamp).toHaveBeenCalled();
    });

    it('resets consecutiveErrors to 0 on successful run', async () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));

      heartbeatService.startHeartbeat(createAgent());
      await heartbeatService.triggerHeartbeat();

      const status = heartbeatService.getStatus();
      expect(status?.consecutiveErrors).toBe(0);
      expect(status?.lastRun).toBeTruthy();
    });
  });

  // ==========================================================================
  // Gate LLM suppression
  // ==========================================================================

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

      heartbeatService.startHeartbeat(createAgent());
      const result = await heartbeatService.triggerHeartbeat();

      expect(result.shouldSkip).toBe(true);
      expect(result.text).toBe('');
      expect(mockDeliverMessage).not.toHaveBeenCalled();
    });

    it('gate returns DELIVER → message delivered', async () => {
      mockInvoke.mockResolvedValue({
        response: 'Pod frontend-abc is in CrashLoopBackOff!',
        toolCalls: [],
        steps: [{ text: 'Pod frontend-abc is in CrashLoopBackOff!', toolCalls: [] }],
      });
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      heartbeatService.startHeartbeat(createAgent());
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

      heartbeatService.startHeartbeat(createAgent());
      const result = await heartbeatService.triggerHeartbeat();

      expect(result.shouldSkip).toBe(false);
      expect(mockDeliverMessage).toHaveBeenCalled();
    });

    it('empty response → gate not called, suppressed', async () => {
      mockInvoke.mockResolvedValue({ response: '', toolCalls: [], steps: [] });

      heartbeatService.startHeartbeat(createAgent());
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

      heartbeatService.startHeartbeat(createAgent());

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

      heartbeatService.startHeartbeat(createAgent());

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

      heartbeatService.startHeartbeat(createAgent());
      await heartbeatService.triggerHeartbeat();

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          maxOutputTokens: 10,
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

      heartbeatService.startHeartbeat(createAgent());
      await heartbeatService.triggerHeartbeat();

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining('meta-commentary about the heartbeat itself'),
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

      heartbeatService.startHeartbeat(createAgent());
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

      heartbeatService.startHeartbeat(createAgent());
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

      heartbeatService.startHeartbeat(createAgent());
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

      heartbeatService.startHeartbeat(createAgent());
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

      heartbeatService.startHeartbeat(createAgent());
      await heartbeatService.triggerHeartbeat();

      const stepLogs = mockLoggerInfo.mock.calls
        .map((c: string[]) => c[0])
        .filter((msg: string) => msg.includes('step 1/2') || msg.includes('step 2/2'));
      expect(stepLogs).toHaveLength(2);
      expect(stepLogs[0]).toContain('tools=[kubectl]');
      expect(stepLogs[1]).toContain('text="All clear"');
    });

    it('logs each step for slack-triggered heartbeat', async () => {
      mockDrainSlackMessages.mockResolvedValueOnce([{
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

      heartbeatService.startHeartbeat(createAgent());
      heartbeatService.triggerFromSlack();
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

      heartbeatService.startHeartbeat(createAgent());
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

      heartbeatService.startHeartbeat(createAgent());

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
      heartbeatService.startHeartbeat(createAgent());

      mockInvoke.mockResolvedValue({ response: 'Alert A', toolCalls: [], steps: [{ text: 'Alert A', toolCalls: [] }] });
      await heartbeatService.triggerHeartbeat();

      mockInvoke.mockResolvedValue({ response: 'Alert B', toolCalls: [], steps: [{ text: 'Alert B', toolCalls: [] }] });
      await heartbeatService.triggerHeartbeat();

      expect(mockDeliverMessage).toHaveBeenCalledTimes(2);
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

      heartbeatService.startHeartbeat(createAgent());
      await heartbeatService.triggerHeartbeat();

      const status = heartbeatService.getStatus();
      expect(status?.consecutiveErrors).toBe(1);
    });

    it('auto-stops heartbeat after 5 consecutive errors', async () => {
      mockInvoke.mockRejectedValue(new Error('Network failure'));

      heartbeatService.startHeartbeat(createAgent());

      for (let i = 0; i < 5; i++) {
        await heartbeatService.triggerHeartbeat();
      }

      // Should have been stopped
      expect(heartbeatService.getStatus()).toBe(null);
    });

    it('does not stop heartbeat before reaching 5 consecutive errors', async () => {
      mockInvoke.mockRejectedValue(new Error('Network failure'));

      heartbeatService.startHeartbeat(createAgent());

      for (let i = 0; i < 4; i++) {
        await heartbeatService.triggerHeartbeat();
      }

      expect(heartbeatService.getStatus()).not.toBe(null);
      expect(heartbeatService.getStatus()?.consecutiveErrors).toBe(4);
    });

    it('returns error message as skipped result on failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Connection refused'));

      heartbeatService.startHeartbeat(createAgent());
      const result = await heartbeatService.triggerHeartbeat();

      expect(result).toEqual({
        shouldSkip: true,
        text: 'Connection refused',
      });
    });

    it('resets consecutiveErrors on a successful run after failures', async () => {
      heartbeatService.startHeartbeat(createAgent());

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

    it('uses a single minimal prompt regardless of vision or proactivity', async () => {
      heartbeatService.startHeartbeat(createAgent());
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
    it('executes heartbeat on each interval tick', async () => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));

      heartbeatService.startHeartbeat(createAgent({ heartbeatIntervalMs: 60_000 }));

      // Advance past one interval
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockInvoke).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Slack-triggered heartbeat (triggerFromSlack)
  // ==========================================================================

  describe('triggerFromSlack', () => {
    const slackMsg = (text: string) => ({
      sender: 'Alice',
      text,
      timestamp: '2025-01-15T12:00:00Z',
    });

    beforeEach(() => {
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });
    });

    it('returns ignored when agent has no heartbeat state', () => {
      const status = heartbeatService.triggerFromSlack();
      expect(status).toBe('ignored');
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('drains messages from DB and passes them into invoke', async () => {
      mockDrainSlackMessages.mockResolvedValueOnce([slackMsg('deploy failed')]);
      mockInvoke.mockResolvedValue({
        response: 'Incident detected!',
        toolCalls: [],
        steps: [{ text: 'Incident detected!', toolCalls: [] }],
      });

      heartbeatService.startHeartbeat(createAgent());
      heartbeatService.triggerFromSlack();

      // Let the fire-and-forget promise resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(mockDrainSlackMessages).toHaveBeenCalledWith('agent-1');
      expect(mockInvoke).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-abc-123',
          mode: 'heartbeat',
          slackMessages: [slackMsg('deploy failed')],
        }),
      );
    });

    it('returns ignored when heartbeat is already running (throttle queue handles next trigger)', async () => {
      let resolveFirst!: (v: unknown) => void;
      mockInvoke.mockReturnValueOnce(new Promise(r => { resolveFirst = r; }));
      mockDrainSlackMessages.mockResolvedValueOnce([slackMsg('msg-1')]);

      heartbeatService.startHeartbeat(createAgent());

      // First trigger starts execution
      heartbeatService.triggerFromSlack();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockInvoke).toHaveBeenCalledTimes(1);

      // Second trigger while first is running — returns ignored
      const status = heartbeatService.triggerFromSlack();
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

    it('delivers the response when gate says DELIVER', async () => {
      mockDrainSlackMessages.mockResolvedValueOnce([slackMsg('prod is down')]);
      mockInvoke.mockResolvedValue({
        response: 'Incident in prod!',
        toolCalls: [],
        steps: [{ text: 'Incident in prod!', toolCalls: [] }],
      });

      heartbeatService.startHeartbeat(createAgent());
      heartbeatService.triggerFromSlack();
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
      mockDrainSlackMessages.mockResolvedValueOnce([slackMsg('check')]);
      mockInvoke.mockResolvedValue({
        response: 'All good',
        toolCalls: [],
        steps: [],
      });

      heartbeatService.startHeartbeat(createAgent());
      heartbeatService.triggerFromSlack();
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
      heartbeatService.startHeartbeat(createAgent({ heartbeatIntervalMs: 60_000 }));

      expect(mockTrackEvent).toHaveBeenCalledWith('heartbeat started', 'user-abc-123', {
        'agent.id': 'agent-1',
        'heartbeat.interval_ms': '60000',
      });
    });

    it('does not emit "heartbeat started" when status is STOPPED', () => {
      heartbeatService.startHeartbeat(createAgent({ heartbeatStatus: 'STOPPED' }));

      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('emits "heartbeat stopped" on stop', () => {
      heartbeatService.startHeartbeat(createAgent());
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

      heartbeatService.startHeartbeat(createAgent());
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

      heartbeatService.startHeartbeat(createAgent());
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

      heartbeatService.startHeartbeat(createAgent());
      await heartbeatService.triggerHeartbeat();

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'heartbeat completed',
        'user-abc-123',
        expect.objectContaining({ 'heartbeat.result': 'budget_exceeded' }),
      );
    });

    it('emits "heartbeat completed" with result=error when invoke throws', async () => {
      mockInvoke.mockRejectedValue(new Error('Network failure'));

      heartbeatService.startHeartbeat(createAgent());
      await heartbeatService.triggerHeartbeat();

      expect(mockTrackEvent).toHaveBeenCalledWith(
        'heartbeat completed',
        'user-abc-123',
        expect.objectContaining({ 'heartbeat.trigger': 'timer', 'heartbeat.result': 'error' }),
      );
    });

    it('tags Slack-triggered runs with trigger=slack', async () => {
      mockDrainSlackMessages.mockResolvedValueOnce([
        { sender: 'Alice', text: 'deploy failed', timestamp: '2025-01-15T12:00:00Z' },
      ]);
      mockInvoke.mockResolvedValue({
        response: 'Incident!',
        toolCalls: [],
        steps: [{ text: 'Incident!', toolCalls: [] }],
      });
      mockGenerateText.mockResolvedValue({ text: 'DELIVER' });

      heartbeatService.startHeartbeat(createAgent());
      heartbeatService.triggerFromSlack();
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
