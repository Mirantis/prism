/**
 * Goal Service Tests
 *
 * Covers startGoal (persist + validation + replace), the background continuation
 * loop's termination paths (gate COMPLETE, turn cap, per-goal token budget,
 * stall, account budget_exceeded), and the user-controlled state changes
 * (stop/pause/resume) + queries.
 *
 * The prisma.goal mock is stateful: a single in-memory `goalRow` is mutated by
 * update/updateMany and re-read by findUnique each loop iteration, so the loop
 * runs end-to-end. GOAL_TURN_DELAY_MS is mocked to 0 so the loop converges fast.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockInvoke,
  mockPublish,
  mockPublishLatest,
  mockGenerateText,
  mockGoalCreate,
  mockGoalFindUnique,
  mockGoalFindFirst,
  mockGoalFindMany,
  mockGoalUpdate,
  mockGoalUpdateMany,
  mockTrackEvent,
  mockEndLoopStatus,
  mockConfig,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockPublish: vi.fn(),
  mockPublishLatest: vi.fn(),
  mockGenerateText: vi.fn(),
  mockGoalCreate: vi.fn(),
  mockGoalFindUnique: vi.fn(),
  mockGoalFindFirst: vi.fn(),
  mockGoalFindMany: vi.fn(),
  mockGoalUpdate: vi.fn(),
  mockGoalUpdateMany: vi.fn(),
  mockTrackEvent: vi.fn(),
  mockEndLoopStatus: vi.fn(),
  mockConfig: { goalMaxTurns: 100, goalDefaultTokenBudget: null as number | null },
}));

vi.mock('../invoke', () => ({ invoke: mockInvoke }));

vi.mock('./message-delivery.service', () => ({
  messageDeliveryService: {
    publish: mockPublish,
    publishToLatestThread: mockPublishLatest,
  },
}));

vi.mock('ai', () => ({ generateText: mockGenerateText }));

vi.mock('./program-status.service', () => ({
  programStatusService: { beginTurn: () => ({ end: mockEndLoopStatus }) },
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    goal: {
      create: mockGoalCreate,
      findUnique: mockGoalFindUnique,
      findFirst: mockGoalFindFirst,
      findMany: mockGoalFindMany,
      update: mockGoalUpdate,
      updateMany: mockGoalUpdateMany,
    },
  },
}));

vi.mock('../lib/classification', () => ({
  getGateRequest: () => ({ model: {}, providerOptions: {} }),
}));
vi.mock('../lib/langfuse', () => ({ isLangfuseEnabled: () => false }));
vi.mock('../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
}));
vi.mock('../config', () => ({ config: mockConfig }));
vi.mock('../constants', () => ({
  GOAL_MAX_OBJECTIVE_CHARS: 4000,
  GOAL_MAX_STALL_TURNS: 2,
  GOAL_TURN_DELAY_MS: 0,
}));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { goalService } from './goal.service';

const TERMINAL = ['complete', 'blocked', 'turn_limited', 'budget_limited', 'stopped'];

// Stateful single-goal store backing the prisma mock.
let goalRow: Record<string, unknown> | null;

function setActiveGoal(overrides: Record<string, unknown> = {}): void {
  goalRow = {
    id: 'goal-1',
    agentId: 'agent-1',
    userId: 'user-1',
    threadId: 'thread-1',
    objective: 'make the tests pass',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    turnCount: 0,
    maxTurns: 100,
    stallCount: 0,
    lastReason: null,
    originChannel: 'websocket',
    originChannelId: null,
    createdAt: new Date(),
    completedAt: null,
    ...overrides,
  };
}

async function waitForTerminal(): Promise<void> {
  await vi.waitFor(
    () => {
      if (!goalRow || !TERMINAL.includes(goalRow.status as string)) {
        throw new Error(`not terminal yet: ${goalRow?.status}`);
      }
    },
    { timeout: 2000, interval: 5 },
  );
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe('GoalService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    goalRow = null;
    mockConfig.goalMaxTurns = 100;
    mockConfig.goalDefaultTokenBudget = null;

    mockGoalCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      goalRow = {
        id: 'goal-1',
        tokensUsed: 0,
        turnCount: 0,
        stallCount: 0,
        lastReason: null,
        createdAt: new Date(),
        completedAt: null,
        ...data,
        tokenBudget: data.tokenBudget ?? null,
      };
      return Promise.resolve({ ...goalRow });
    });
    mockGoalFindUnique.mockImplementation(() => Promise.resolve(goalRow ? { ...goalRow } : null));
    mockGoalFindFirst.mockImplementation(() =>
      Promise.resolve(goalRow && ['active', 'paused'].includes(goalRow.status as string) ? { ...goalRow } : null),
    );
    mockGoalFindMany.mockImplementation((arg?: { where?: { status?: unknown } }) => {
      if (!goalRow) return Promise.resolve([]);
      const status = arg?.where?.status as { in?: string[] } | string | undefined;
      const allowed = typeof status === 'string' ? [status] : status?.in;
      if (allowed && !allowed.includes(goalRow.status as string)) return Promise.resolve([]);
      return Promise.resolve([{ ...goalRow }]);
    });
    mockGoalUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      goalRow = { ...(goalRow as object), ...data };
      return Promise.resolve({ ...goalRow });
    });
    mockGoalUpdateMany.mockImplementation(() => {
      if (goalRow && ['active', 'paused'].includes(goalRow.status as string)) {
        goalRow = { ...goalRow, status: 'stopped', completedAt: new Date() };
      }
      return Promise.resolve({ count: 1 });
    });

    // Default: a productive turn (has a tool call) that's not yet complete.
    mockInvoke.mockResolvedValue({
      response: 'working on it',
      toolCalls: [{ tool: 'shell_exec', input: '{}', output: 'ok', success: true, timestamp: '2025-01-01T00:00:00Z' }],
      steps: [{ text: 'working on it' }],
      usage: { totalTokens: 10 },
    });
    mockPublish.mockResolvedValue({ id: 'msg-1' });
    mockGenerateText.mockResolvedValue({ text: 'CONTINUE' });
  });

  afterEach(async () => {
    goalService.stopAll();
    await flush();
  });

  // ==========================================================================
  // startGoal
  // ==========================================================================

  describe('startGoal', () => {
    it('persists an active goal with the configured turn cap and origin channel', async () => {
      mockConfig.goalMaxTurns = 42;
      mockGenerateText.mockResolvedValue({ text: 'COMPLETE' }); // finish after one turn

      const goal = await goalService.startGoal({
        userId: 'user-1',
        agentId: 'agent-1',
        threadId: 'thread-1',
        objective: 'ship the feature',
        originChannel: 'websocket',
      });

      expect(goal.status).toBe('active');
      expect(mockGoalCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          objective: 'ship the feature',
          status: 'active',
          maxTurns: 42,
          originChannel: 'websocket',
        }),
      });
      // Creation telemetry — no objective text (PII).
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'goal started',
        'user-1',
        expect.objectContaining({ 'goal.id': expect.any(String), 'goal.max_turns': '42' }),
      );
      await waitForTerminal();
    });

    it('rejects an empty objective', async () => {
      await expect(
        goalService.startGoal({ userId: 'u', agentId: 'a', threadId: 't', objective: '   ', originChannel: 'websocket' }),
      ).rejects.toThrow(/objective is required/i);
      expect(mockGoalCreate).not.toHaveBeenCalled();
    });

    it('rejects an over-long objective', async () => {
      await expect(
        goalService.startGoal({
          userId: 'u',
          agentId: 'a',
          threadId: 't',
          objective: 'x'.repeat(4001),
          originChannel: 'websocket',
        }),
      ).rejects.toThrow(/too long/i);
      expect(mockGoalCreate).not.toHaveBeenCalled();
    });

    it('replaces any existing live goal on the thread (one active per thread)', async () => {
      setActiveGoal({ id: 'old', status: 'active' });
      mockGenerateText.mockResolvedValue({ text: 'COMPLETE' });

      await goalService.startGoal({
        userId: 'user-1',
        agentId: 'agent-1',
        threadId: 'thread-1',
        objective: 'new objective',
        originChannel: 'websocket',
      });

      expect(mockGoalUpdateMany).toHaveBeenCalled(); // stopped the prior goal
      // The superseded goal emits a 'goal stopped' event (reason: replaced).
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'goal stopped',
        'user-1',
        expect.objectContaining({ 'goal.id': 'old', 'goal.reason': 'replaced' }),
      );
      await waitForTerminal();
    });
  });

  // ==========================================================================
  // Background loop termination paths
  // ==========================================================================

  describe('continuation loop', () => {
    it('completes after one turn when the gate says COMPLETE', async () => {
      mockGenerateText.mockResolvedValue({ text: 'COMPLETE' });

      await goalService.startGoal({
        userId: 'user-1',
        agentId: 'agent-1',
        threadId: 'thread-1',
        objective: 'do the thing',
        originChannel: 'websocket',
      });
      await waitForTerminal();

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith(expect.objectContaining({ mode: 'goal', threadId: 'thread-1' }));
      expect(goalRow!.status).toBe('complete');
      expect(goalRow!.turnCount).toBe(1);
      expect(goalRow!.tokensUsed).toBe(10);
      // The turn output + the completion notice are both delivered with 'GOAL'.
      expect(mockPublish).toHaveBeenCalledWith('user-1', 'thread-1', expect.any(String), 'GOAL', expect.anything());
      expect(mockPublish.mock.calls.length).toBeGreaterThanOrEqual(2);
      // Completion telemetry carries turns + elapsed time, never the objective.
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'goal finished',
        'user-1',
        expect.objectContaining({
          'goal.status': 'complete',
          'goal.turns': '1',
          'goal.elapsed_ms': expect.any(String),
        }),
      );
      const finishedCall = mockTrackEvent.mock.calls.find((c) => c[0] === 'goal finished');
      expect(JSON.stringify(finishedCall)).not.toContain('do the thing'); // no objective (PII)
      await vi.waitFor(() => expect(mockEndLoopStatus).toHaveBeenCalledWith({ cancelled: false }));
    });

    it('runs each turn in the channel the goal was started in', async () => {
      mockGenerateText.mockResolvedValue({ text: 'COMPLETE' });

      await goalService.startGoal({
        userId: 'user-1',
        agentId: 'agent-1',
        threadId: 'thread-1',
        objective: 'do the thing',
        originChannel: 'slack',
        originChannelId: 'C0123',
      });
      await waitForTerminal();

      // A computer help request from the turn asks where the goal delivers.
      expect(mockInvoke).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'goal', originChannel: 'slack', originChannelId: 'C0123' }),
      );
    });

    it('runs the turns of a goal from a channel no adapter serves in the web chat', async () => {
      mockGenerateText.mockResolvedValue({ text: 'COMPLETE' });

      await goalService.startGoal({
        userId: 'user-1',
        agentId: 'agent-1',
        threadId: 'thread-1',
        objective: 'do the thing',
        originChannel: 'retired-channel',
      });
      await waitForTerminal();

      expect(mockInvoke).toHaveBeenCalledWith(expect.objectContaining({ originChannel: 'websocket' }));
    });

    it('stops at the turn cap without invoking when maxTurns is reached', async () => {
      mockConfig.goalMaxTurns = 0;

      await goalService.startGoal({
        userId: 'user-1',
        agentId: 'agent-1',
        threadId: 'thread-1',
        objective: 'never runs',
        originChannel: 'websocket',
      });
      await waitForTerminal();

      expect(goalRow!.status).toBe('turn_limited');
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('stops at the per-goal token budget', async () => {
      // Budget 5, each turn costs 10 → exceeded after one turn.
      await goalService.startGoal({
        userId: 'user-1',
        agentId: 'agent-1',
        threadId: 'thread-1',
        objective: 'spendy',
        tokenBudget: 5,
        originChannel: 'websocket',
      });
      await waitForTerminal();

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(goalRow!.status).toBe('budget_limited');
    });

    it('blocks after consecutive zero-progress (no tool call) turns', async () => {
      mockInvoke.mockResolvedValue({
        response: 'just talking',
        toolCalls: [],
        steps: [{ text: 'just talking' }],
        usage: { totalTokens: 3 },
      });

      await goalService.startGoal({
        userId: 'user-1',
        agentId: 'agent-1',
        threadId: 'thread-1',
        objective: 'stuck',
        originChannel: 'websocket',
      });
      await waitForTerminal();

      expect(goalRow!.status).toBe('blocked');
      expect(mockInvoke).toHaveBeenCalledTimes(2); // GOAL_MAX_STALL_TURNS
      // finalize must report the up-to-date token count (2 turns × 3 tokens),
      // not the stale pre-turn value.
      expect(goalRow!.tokensUsed).toBe(6);
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'goal finished',
        'user-1',
        expect.objectContaining({ 'goal.status': 'blocked', 'goal.tokens': '6', 'goal.turns': '2' }),
      );
    });

    it('stops on an account-level budget_exceeded error', async () => {
      mockInvoke.mockResolvedValue({
        response: '',
        toolCalls: [],
        steps: [],
        usage: { totalTokens: 0 },
        error: { type: 'budget_exceeded', detail: null },
      });

      await goalService.startGoal({
        userId: 'user-1',
        agentId: 'agent-1',
        threadId: 'thread-1',
        objective: 'too pricey',
        originChannel: 'websocket',
      });
      await waitForTerminal();

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(goalRow!.status).toBe('budget_limited');
    });
  });

  // ==========================================================================
  // User-controlled state + queries
  // ==========================================================================

  describe('stop / pause / resume', () => {
    it('stopGoal marks a live goal stopped and emits telemetry', async () => {
      setActiveGoal();
      const result = await goalService.stopGoal('goal-1');
      expect(result!.status).toBe('stopped');
      expect(mockGoalUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'stopped' }) }),
      );
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'goal stopped',
        'user-1',
        expect.objectContaining({ 'goal.id': 'goal-1', 'goal.reason': 'user' }),
      );
    });

    it('stopGoal returns null for a missing goal (no telemetry)', async () => {
      goalRow = null;
      expect(await goalService.stopGoal('nope')).toBeNull();
      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('pauseGoal pauses an active goal and emits telemetry', async () => {
      setActiveGoal();
      const result = await goalService.pauseGoal('goal-1');
      expect(result!.status).toBe('paused');
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'goal paused',
        'user-1',
        expect.objectContaining({ 'goal.id': 'goal-1' }),
      );
    });

    it('resumeGoal reactivates a paused goal, emits telemetry, and restarts the loop', async () => {
      setActiveGoal({ status: 'paused' });
      mockGenerateText.mockResolvedValue({ text: 'COMPLETE' });

      const result = await goalService.resumeGoal('goal-1');
      expect(result!.status).toBe('active');
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'goal resumed',
        'user-1',
        expect.objectContaining({ 'goal.id': 'goal-1' }),
      );
      await waitForTerminal(); // the restarted loop runs to completion
      expect(mockInvoke).toHaveBeenCalled();
    });

    it('reports the loop as cancelled when the goal stops between two turns', async () => {
      let releaseGate!: () => void;
      mockGenerateText.mockImplementationOnce(
        () => new Promise((resolve) => (releaseGate = () => resolve({ text: 'CONTINUE' }))),
      );

      await goalService.startGoal({
        userId: 'user-1',
        agentId: 'agent-1',
        threadId: 'thread-1',
        objective: 'stop me',
        originChannel: 'websocket',
      });
      await vi.waitFor(() => expect(releaseGate).toBeDefined());
      await goalService.stopGoal('goal-1');
      releaseGate();

      await vi.waitFor(() => expect(mockEndLoopStatus).toHaveBeenCalledWith({ cancelled: true }));
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledWith('user-1', 'thread-1', 'working on it', 'GOAL', expect.anything());
    });

    it('restarts the loop on resume even while the prior turn is still unwinding', async () => {
      // The first turn's invoke hangs, so when pause lands the loop is still
      // running (isRunning) but aborted — the resume-race window. The resumed
      // loop must still start and finish the goal, not be dropped.
      let releaseFirstTurn!: () => void;
      const firstTurn = new Promise<void>((resolve) => {
        releaseFirstTurn = resolve;
      });
      mockInvoke.mockImplementationOnce(async () => {
        await firstTurn;
        return {
          response: 'partial',
          toolCalls: [{ tool: 'shell_exec', input: '{}', output: 'ok', success: true, timestamp: '2025-01-01T00:00:00Z' }],
          steps: [{ text: 'partial' }],
          usage: { totalTokens: 5 },
        };
      });
      mockGenerateText.mockResolvedValue({ text: 'COMPLETE' });

      await goalService.startGoal({
        userId: 'user-1',
        agentId: 'agent-1',
        threadId: 'thread-1',
        objective: 'race',
        originChannel: 'websocket',
      });
      await flush(); // let the loop reach the (hanging) first invoke
      expect(mockInvoke).toHaveBeenCalledTimes(1);

      // Pause mid-turn (aborts the still-running loop), then immediately resume.
      await goalService.pauseGoal('goal-1');
      await goalService.resumeGoal('goal-1');

      releaseFirstTurn(); // the original turn returns; the old loop unwinds
      await waitForTerminal(); // the resumed loop must run and finish the goal

      expect(goalRow!.status).toBe('complete');
      expect(mockInvoke.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('queries', () => {
    it('getGoalForThread returns the live goal', async () => {
      setActiveGoal();
      const goal = await goalService.getGoalForThread('thread-1');
      expect(goal!.objective).toBe('make the tests pass');
    });

    it('listGoals returns all goals for the agent', async () => {
      setActiveGoal();
      const goals = await goalService.listGoals('agent-1');
      expect(goals).toHaveLength(1);
    });
  });

  // ==========================================================================
  // restoreActiveGoals
  // ==========================================================================

  describe('restoreActiveGoals', () => {
    it('restarts loops for active goals on boot', async () => {
      setActiveGoal({ status: 'active' });
      mockGenerateText.mockResolvedValue({ text: 'COMPLETE' });

      await goalService.restoreActiveGoals('agent-1');
      await waitForTerminal();

      expect(mockInvoke).toHaveBeenCalled();
      expect(goalRow!.status).toBe('complete');
    });

    it('tells the first turn of a restored goal that the restart may have stopped a turn part-way', async () => {
      setActiveGoal({ status: 'active' });
      mockGenerateText.mockResolvedValueOnce({ text: 'CONTINUE' }).mockResolvedValue({ text: 'COMPLETE' });

      await goalService.restoreActiveGoals('agent-1');
      await waitForTerminal();

      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(mockInvoke.mock.calls[0][0]).toMatchObject({ afterRestart: true });
      expect(mockInvoke.mock.calls[1][0].afterRestart).toBe(false);
    });

    it('delivers and counts nothing for a turn a shutdown stopped, so the restored loop runs it again', async () => {
      setActiveGoal({ status: 'active' });
      let finishTurn!: () => void;
      mockInvoke.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishTurn = () => resolve({ response: 'half done', toolCalls: [], steps: [{ text: 'half done' }] });
          }),
      );

      await goalService.restoreActiveGoals('agent-1');
      await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalled());
      goalService.stopAll();
      finishTurn();
      await flush();

      expect(mockPublish).not.toHaveBeenCalled();
      expect(goalRow!.status).toBe('active');
      expect(goalRow!.turnCount).toBe(0);
    });
  });
});
