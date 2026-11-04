/**
 * Unit tests for the AgentTaskManager. A scripted fake `CodingAgent` stands in
 * for the real adapter, so these exercise the buffer/drain/complete/stop state
 * machine on the neutral events every adapter emits, without a child process.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockBeginWork, mockUpdateWork, mockSettleWork, mockEndWork, mockStopLeftover } = vi.hoisted(() => ({
  mockBeginWork: vi.fn(),
  mockUpdateWork: vi.fn(),
  mockSettleWork: vi.fn(),
  mockEndWork: vi.fn(),
  mockStopLeftover: vi.fn(),
}));

const { shutdown } = vi.hoisted(() => ({ shutdown: new AbortController() }));

vi.mock('../../../services/pending-work.service', () => ({
  pendingWorkService: {
    begin: mockBeginWork,
    update: mockUpdateWork,
    settle: mockSettleWork,
    end: mockEndWork,
    shutdownSignal: shutdown.signal,
  },
}));

const { mockDeliver } = vi.hoisted(() => ({ mockDeliver: vi.fn() }));

vi.mock('../../../services/task-notification.service', () => ({
  taskNotificationService: { deliver: mockDeliver },
}));

const { mockReadPluginConfigs, mockConfiguredServers } = vi.hoisted(() => ({
  mockReadPluginConfigs: vi.fn(async () => undefined),
  mockConfiguredServers: vi.fn(() => [] as unknown[]),
}));

vi.mock('../../../services/plugin-mcp.service', () => ({
  pluginMcpService: { readConfigs: mockReadPluginConfigs, configuredServers: mockConfiguredServers },
}));

vi.mock('../../../lib/execution-environments/leftover-process', () => ({
  stopLeftoverProcess: mockStopLeftover,
}));

import { config } from '../../../config';
import { trackEvent } from '../../../lib/telemetry';
import { RESUMED_CODING_TASK_PROMPT } from '../../../prompts/resume-prompt';
import { buildCodingAgentInput, runCodingAgent } from '../coding-agent';

import { AsyncChannel } from '../../../utils/async-channel';
import type {
  CodingAgent,
  CodingAgentEvent,
  CodingAgentRun,
  CodingAgentTask,
} from '../../../lib/coding-agents/coding-agent';
import type { ProcessMark } from '../../../lib/execution-environments/execution-environment';
import {
  AgentTaskManager,
  __setAgentTaskManagerForTests,
  AgentTaskParams,
  DEFAULT_MAX_TURNS,
  MAX_BUFFER_SIZE,
  MAX_CONCURRENT,
} from '../agent-task-manager';

vi.mock('../../../lib/telemetry', () => ({ trackEvent: vi.fn() }));

type ResultEvent = Extract<CodingAgentEvent, { type: 'result' }>;

/**
 * A run the test drives by hand. `stop()` ends the stream the way a killed CLI
 * does — a closing error result — unless the run is `stubborn`, in which case
 * it never ends and the manager has to give up on its own.
 */
class FakeRun implements CodingAgentRun {
  private channel = new AsyncChannel<CodingAgentEvent>();
  readonly events: AsyncIterable<CodingAgentEvent> = this.channel;
  exited = false;
  stopped = false;
  mark: ProcessMark | undefined = { pid: 4242, startedAt: 1_000 };
  readonly started: Promise<void>;
  private begin = (): void => undefined;

  /** With `lateStart` the process starts only on `start()`, as a run that checks something first. */
  constructor(private readonly stubborn = false, lateStart = false) {
    if (!lateStart) {
      this.started = Promise.resolve();
      return;
    }
    this.mark = undefined;
    this.started = new Promise((resolve) => {
      this.begin = resolve;
    });
  }

  start(): void {
    this.mark = { pid: 4242, startedAt: 1_000 };
    this.begin();
  }

  emit(event: CodingAgentEvent): void {
    this.channel.push(event);
  }

  /** The agent finished on its own: its result, then the stream closes. */
  finish(result: Omit<ResultEvent, 'type'>): void {
    this.emit({ type: 'result', ...result });
    this.end();
  }

  /** The stream closes without any result, as a broken adapter would. */
  end(): void {
    this.exited = true;
    this.channel.close();
  }

  stop(): void {
    this.stopped = true;
    if (this.stubborn) return;
    this.finish({ stopReason: 'error', turns: 0, message: 'Fake Agent exited with code 143' });
  }
}

const SUCCESS: Omit<ResultEvent, 'type'> = { stopReason: 'end_turn', turns: 1, message: 'ok' };

function makeManager({ stubborn = false, lateStart = false } = {}): {
  manager: AgentTaskManager;
  getRun: () => FakeRun;
  getTask: () => CodingAgentTask;
} {
  let lastRun: FakeRun | null = null;
  let lastTask: CodingAgentTask | null = null;
  const agent: CodingAgent = {
    id: 'claude-code',
    displayName: 'Fake Agent',
    prepareHome: () => ({ configDir: '', skillsLinked: true }),
    run: (task) => {
      lastTask = task;
      lastRun = new FakeRun(stubborn, lateStart);
      return lastRun;
    },
  };
  return {
    manager: new AgentTaskManager(() => agent),
    getRun: () => {
      if (!lastRun) throw new Error('run not started yet');
      return lastRun;
    },
    getTask: () => {
      if (!lastTask) throw new Error('run not started yet');
      return lastTask;
    },
  };
}

const sampleParams: AgentTaskParams = {
  prompt: 'do X',
};

/**
 * Drive readStatus in a loop until the task reports completion. Mirrors how a
 * real caller would poll; each iteration accumulates drained output.
 */
async function pollUntilComplete(
  manager: AgentTaskManager,
  taskId: string,
  { timeoutMs = 2000, waitMs = 30 } = {},
): Promise<{ output: string; status: Awaited<ReturnType<AgentTaskManager['readStatus']>> }> {
  let output = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await manager.readStatus(taskId, waitMs);
    output += status.output;
    if (status.completed) return { output, status };
  }
  throw new Error(`task ${taskId} did not complete within ${timeoutMs}ms`);
}

/**
 * Let the driver run to its finalize after the run ends: the channel close, the
 * end of the event loop and the state write all land within a few macrotask
 * turns. Turn-based rather than a timed sleep, so it is deterministic.
 */
async function flush(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('AgentTaskManager', () => {
  let manager: AgentTaskManager;
  let getRun: () => FakeRun;
  let getTask: () => CodingAgentTask;

  beforeEach(() => {
    const m = makeManager();
    manager = m.manager;
    getRun = m.getRun;
    getTask = m.getTask;
    mockBeginWork.mockResolvedValue(undefined);
    mockStopLeftover.mockResolvedValue(false);
  });

  it('routes mixed agents through one task manager and one concurrency limit', async () => {
    const runs: FakeRun[] = [];
    const resolve = vi.fn((id: 'claude-code' | 'codex'): CodingAgent => ({
      id, displayName: id, prepareHome: () => ({ configDir: '', skillsLinked: true }),
      run: () => { const run = new FakeRun(); runs.push(run); return run; },
    }));
    const tasks = new AgentTaskManager(resolve);
    const original = config.codingAgent;
    config.codingAgent = 'codex';
    try {
      const defaultTask = await tasks.startTask(sampleParams);
      const explicitTask = await tasks.startTask({ ...sampleParams, agent: 'claude-code' });
      const thirdTask = await tasks.startTask({ ...sampleParams, agent: 'codex' });
      expect([defaultTask.agent, explicitTask.agent, thirdTask.agent]).toEqual(['codex', 'claude-code', 'codex']);
      expect(resolve.mock.calls.map(([id]) => id)).toEqual(['codex', 'claude-code', 'codex']);
      await expect(tasks.startTask({ ...sampleParams, agent: 'claude-code' })).rejects.toThrow('Max concurrent agent tasks');
      runs[0].finish({ stopReason: 'end_turn', turns: 1, message: 'Codex finished' });
      await flush();
      expect(await tasks.readStatus(defaultTask.taskId, 0)).toMatchObject({ agent: 'codex', result: 'Codex finished' });
      expect(await tasks.stopTask(explicitTask.taskId)).toMatchObject({ agent: 'claude-code', stopReason: 'stopped' });
      expect(runs[2].stopped).toBe(false);
      await tasks.stopTask(thirdTask.taskId);

    } finally {
      config.codingAgent = original;
      tasks.killAll();
    }
  });

  it.each([undefined, 'session-1'])('passes model and effort through the tool for session %s', async (sessionId) => {
    __setAgentTaskManagerForTests(manager);
    try {
      const input = buildCodingAgentInput().parse({ prompt: 'do X', model: 'small', effort: 'low', sessionId });
      await runCodingAgent(input, '/work');
      expect(getTask()).toMatchObject({ modelTier: 'small', effort: 'low', sessionId });
    } finally {
      __setAgentTaskManagerForTests(null);
      manager.killAll();
    }
  });

  it('keeps omitted model and effort undefined through the tool', async () => {
    __setAgentTaskManagerForTests(manager);
    try {
      await runCodingAgent(buildCodingAgentInput().parse({ prompt: 'do X' }), '/work');
      expect(getTask().modelTier).toBeUndefined();
      expect(getTask().effort).toBeUndefined();
    } finally {
      __setAgentTaskManagerForTests(null);
      manager.killAll();
    }
  });

  it.each([
    { model: 'opus' }, { model: 'SMALL' }, { model: '' }, { model: null },
    { effort: 'max' }, { effort: 'LOW' }, { effort: '' }, { effort: null },
  ])('rejects invalid tier or effort %j', (params) => {
    expect(buildCodingAgentInput().safeParse({ prompt: 'do X', ...params }).success).toBe(false);
  });

  it.each(['small', 'medium', 'large'])('accepts %s with every effort', (model) => {
    for (const effort of ['low', 'medium', 'high']) {
      expect(buildCodingAgentInput().parse({ prompt: 'do X', model, effort })).toMatchObject({ model, effort });
    }
  });

  it('returns the selected adapter from the coding tool', async () => {
    const original = config.codingAgent;
    config.codingAgent = 'codex';
    __setAgentTaskManagerForTests(manager);
    try {
      const result = await runCodingAgent(sampleParams, '/work');
      expect(result).toEqual({ taskId: expect.any(String), agent: 'claude-code' });
      getRun().finish(SUCCESS);
      await flush();
      expect((await manager.readStatus(result.taskId, 0)).agent).toBe(result.agent);
    } finally {
      config.codingAgent = original;
      __setAgentTaskManagerForTests(null);
      manager.killAll();
    }
  });

  it('startTask returns a taskId and tracks the task', async () => {
    const { taskId } = await manager.startTask(sampleParams);
    expect(typeof taskId).toBe('string');
    expect(taskId.length).toBeGreaterThan(0);
    expect(manager.runningCount()).toBe(1);
  });

  it('hands the agent the task inputs and the sandbox environment', async () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, HUSKY: process.env.HUSKY };
    process.env.NODE_ENV = 'production';
    process.env.HUSKY = '0';
    let taskId: string;
    try {
      ({ taskId } = await manager.startTask({
        ...sampleParams,
        workdir: '/work',
        mode: 'plan',
        maxTurns: 7,
        appendSystemPrompt: 'framing',
        sessionId: 'sess-prev',
        debug: true,
      }));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const task = getTask();
    expect(task).toMatchObject({
      taskId,
      prompt: 'do X',
      workdir: '/work',
      mode: 'plan',
      maxTurns: 7,
      appendSystemPrompt: 'framing',
      sessionId: 'sess-prev',
      debug: true,
    });
    // Server-only vars are stripped; everything else passes through.
    expect(task.env.NODE_ENV).toBeUndefined();
    expect(task.env.HUSKY).toBeUndefined();
    expect(task.env.PATH).toBe(process.env.PATH);
  });

  it('defaults to edit mode and the standard turn budget', async () => {
    await manager.startTask(sampleParams);
    expect(getTask()).toMatchObject({ mode: 'edit', maxTurns: DEFAULT_MAX_TURNS });
  });

  it("gives the task the agent's MCP servers", async () => {
    const saved = config.nexusMcpUrl;
    config.nexusMcpUrl = 'https://gateway.example.test/projects/p/mcp';
    try {
      await manager.startTask(sampleParams);
    } finally {
      config.nexusMcpUrl = saved;
    }
    expect(getTask().mcpServers).toEqual([
      { kind: 'http', name: 'nexus', url: 'https://gateway.example.test/projects/p/mcp', headers: {} },
    ]);
  });

  it('buffers text and delivers it on readStatus (drain-on-read)', async () => {
    const { taskId } = await manager.startTask(sampleParams);
    const run = getRun();
    run.emit({ type: 'text', text: 'hello ' });
    run.emit({ type: 'text', text: 'world' });
    run.finish(SUCCESS);

    const { output, status } = await pollUntilComplete(manager, taskId);
    expect(output).toBe('hello world');
    expect(status.completed).toBe(true);
  });

  it('reports completion + result fields once the run ends', async () => {
    const { taskId } = await manager.startTask(sampleParams);
    const run = getRun();
    run.emit({ type: 'text', text: 'final answer' });
    run.emit({ type: 'session', sessionId: 'sess-42' });
    run.finish({ stopReason: 'end_turn', turns: 7, message: 'final answer' });

    const { output, status } = await pollUntilComplete(manager, taskId);
    expect(output).toBe('final answer');
    expect(status.completed).toBe(true);
    expect(status.stopReason).toBe('end_turn');
    expect(status.turns).toBe(7);
    expect(status.sessionId).toBe('sess-42');
    expect(status.result).toBe('final answer');
    expect(status.refusals).toBeUndefined();
    expect(trackEvent).not.toHaveBeenCalledWith('coding task refused', expect.anything(), expect.anything());

    // After completion is delivered once + the next empty read, the task is
    // reaped and subsequent lookups error.
    await expect(manager.readStatus(taskId)).rejects.toThrow(/cleaned up/);
  });

  it("uses the agent's message as the result when it produced no text", async () => {
    const { taskId } = await manager.startTask(sampleParams);
    getRun().finish({ stopReason: 'end_turn', turns: 2, message: 'summary' });
    const { status } = await pollUntilComplete(manager, taskId);
    expect(status.result).toBe('summary');
  });

  it('appends a non-success outcome to the text it produced', async () => {
    const { taskId } = await manager.startTask(sampleParams);
    const run = getRun();
    run.emit({ type: 'text', text: 'partial' });
    run.finish({ stopReason: 'max_turns', turns: 100, message: 'hit max' });

    const { status } = await pollUntilComplete(manager, taskId);
    expect(status.stopReason).toBe('max_turns');
    expect(status.result).toBe('partial\n\n[max_turns]: hit max');
  });

  it('reports a run its permission checks refused part of as refused, naming each action', async () => {
    const { taskId } = await manager.startTask(sampleParams);
    const run = getRun();
    run.emit({ type: 'text', text: 'Steps 1 and 2 are done.' });
    run.finish({
      stopReason: 'end_turn', turns: 5, message: 'Steps 1 and 2 are done.',
      refusals: [
        { action: 'Bash', target: 'git push --force origin main' },
        { action: 'Write', target: '/work/forbidden.txt' },
      ],
    });

    const { status } = await pollUntilComplete(manager, taskId);
    expect(status.stopReason).toBe('refused');
    expect(status.refusals).toEqual([
      { action: 'Bash', target: 'git push --force origin main' },
      { action: 'Write', target: '/work/forbidden.txt' },
    ]);
    expect(status.result).toBe(
      'Steps 1 and 2 are done.\n\n[refused]: Fake Agent did not run these actions, because its permission checks refused them:\n' +
      '- Bash: git push --force origin main\n- Write: /work/forbidden.txt',
    );
    expect(trackEvent).toHaveBeenCalledWith('coding task refused', 'test-owner-id', {
      'task.id': taskId, 'task.agent': 'claude-code', 'task.mode': 'edit', 'task.stop_reason': 'end_turn', 'task.refusals': '2',
    });
  });

  it('keeps a failed outcome as it is and lists its refusals after it', async () => {
    const { taskId } = await manager.startTask({ ...sampleParams, mode: 'plan' });
    getRun().finish({
      stopReason: 'max_turns', turns: 3, message: 'hit max',
      refusals: [{ action: 'Bash', target: 'touch marker.txt' }],
    });

    const { status } = await pollUntilComplete(manager, taskId);
    expect(status.stopReason).toBe('max_turns');
    expect(status.result).toBe(
      'Error (max_turns): hit max\n\n[refused]: Fake Agent did not run these actions, because its permission checks refused them:\n' +
      '- Bash: touch marker.txt',
    );
    expect(trackEvent).toHaveBeenCalledWith('coding task refused', 'test-owner-id', {
      'task.id': taskId, 'task.agent': 'claude-code', 'task.mode': 'plan', 'task.stop_reason': 'max_turns', 'task.refusals': '1',
    });
  });

  it('reports a non-success outcome with no text as an error', async () => {
    const { taskId } = await manager.startTask(sampleParams);
    getRun().finish({ stopReason: 'error', turns: 0, message: 'boom' });

    const { status } = await pollUntilComplete(manager, taskId);
    expect(status.stopReason).toBe('error');
    expect(status.result).toBe('Error (error): boom');
  });

  it('fails a task whose run ends without reporting a result', async () => {
    const { taskId } = await manager.startTask(sampleParams);
    getRun().end();

    const { status } = await pollUntilComplete(manager, taskId);
    expect(status.stopReason).toBe('error');
    expect(status.result).toMatch(/Fake Agent ended without reporting a result/);
  });

  it('truncates the output buffer when it exceeds MAX_BUFFER_SIZE', async () => {
    const { taskId } = await manager.startTask(sampleParams);
    const run = getRun();
    run.emit({ type: 'text', text: 'x'.repeat(MAX_BUFFER_SIZE + 1000) });
    run.finish(SUCCESS);

    const { output } = await pollUntilComplete(manager, taskId);
    expect(output.startsWith('[...output truncated...]\n')).toBe(true);
    // ~1 MiB payload plus the truncation marker.
    expect(output.length).toBeLessThanOrEqual(MAX_BUFFER_SIZE + 64);
  });

  it('enforces MAX_CONCURRENT on startTask', async () => {
    for (let i = 0; i < MAX_CONCURRENT; i++) await manager.startTask(sampleParams);
    await expect(manager.startTask(sampleParams)).rejects.toThrow(/Max concurrent/);
  });

  it('readStatus on an unknown taskId throws', async () => {
    await expect(manager.readStatus('no-such-id')).rejects.toThrow(/Unknown task/);
  });

  it('stopTask terminates a running task and returns the output so far', async () => {
    const { taskId } = await manager.startTask(sampleParams);
    const run = getRun();
    run.emit({ type: 'text', text: 'partial work' });

    const status = await manager.stopTask(taskId);
    expect(run.stopped).toBe(true);
    expect(status.completed).toBe(true);
    expect(status.stopReason).toBe('stopped');
    expect(status.output).toBe('partial work');
    // The run's closing error must not be reported as a task failure.
    expect(status.result).toBe('partial work');
  });

  it('stopTask reports the session id so the abandoned work can be resumed', async () => {
    const { taskId } = await manager.startTask(sampleParams);
    // The agent announces its session early — the only place a killed task's
    // session id appears, since it never reaches a final result.
    getRun().emit({ type: 'session', sessionId: 'sess-init' });

    const status = await manager.stopTask(taskId);
    expect(status.sessionId).toBe('sess-init');
    expect(status.result).toBe('Task stopped before producing any output.');
  });

  it('stopTask frees the concurrency slot', async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT; i++) ids.push((await manager.startTask(sampleParams)).taskId);
    await expect(manager.startTask(sampleParams)).rejects.toThrow(/Max concurrent/);

    await manager.stopTask(ids[0]);
    await expect(manager.startTask(sampleParams)).resolves.toBeDefined();
  });

  it('stopTask rejects an unknown or already-stopped taskId', async () => {
    await expect(manager.stopTask('no-such-id')).rejects.toThrow(/Unknown task/);

    const { taskId } = await manager.startTask(sampleParams);
    await manager.stopTask(taskId);
    await expect(manager.stopTask(taskId)).rejects.toThrow(/cleaned up/);
    await expect(manager.readStatus(taskId)).rejects.toThrow(/cleaned up/);
  });

  it('stopTask on a task that already finished keeps its real outcome', async () => {
    const { taskId } = await manager.startTask(sampleParams);
    const run = getRun();
    run.emit({ type: 'text', text: 'done text' });
    run.finish({ stopReason: 'end_turn', turns: 3, message: 'done' });
    await flush();

    const status = await manager.stopTask(taskId);
    expect(status.stopReason).toBe('end_turn');
    expect(status.turns).toBe(3);
    expect(status.output).toBe('done text');
    expect(run.stopped).toBe(false);
  });

  it('stopTask does not relabel a run that ended just before the stop', async () => {
    const { taskId } = await manager.startTask(sampleParams);
    const run = getRun();
    run.emit({ type: 'session', sessionId: 'sess-real' });
    // Ends, but stop *before* drive() gets to its finalize — the window between
    // the run ending and the state being written.
    run.finish({ stopReason: 'end_turn', turns: 3, message: 'THE REAL FINAL RESULT' });

    const status = await manager.stopTask(taskId);
    expect(run.stopped).toBe(false);
    expect(status.stopReason).toBe('end_turn');
    expect(status.result).toBe('THE REAL FINAL RESULT');
    expect(status.turns).toBe(3);
    expect(status.sessionId).toBe('sess-real');
  });

  it('stopTask still reports output and a session id when the run never ends', async () => {
    const { manager: m, getRun: get } = makeManager({ stubborn: true });
    const { taskId } = await m.startTask(sampleParams);
    const run = get();
    run.emit({ type: 'session', sessionId: 'sess-stubborn' });
    run.emit({ type: 'text', text: 'half-done work' });

    const status = await m.stopTask(taskId);
    expect(run.stopped).toBe(true);
    expect(status.completed).toBe(true);
    expect(status.stopReason).toBe('stopped');
    expect(status.output).toBe('half-done work');
    // The whole point of the fallback: the resume path survives it, even though
    // no result ever arrives to close the stream.
    expect(status.sessionId).toBe('sess-stubborn');
  }, 15_000);

  it('stopTask wakes a parked poll instead of leaving it to time out', async () => {
    const { manager: m, getRun: get } = makeManager({ stubborn: true });
    const { taskId } = await m.startTask(sampleParams);
    // Only the session, so there is nothing to drain and the poll really parks.
    get().emit({ type: 'session', sessionId: 'sess-stubborn' });

    const started = Date.now();
    const parked = m.readStatus(taskId, 25_000);
    const parkedStatus = await Promise.all([m.stopTask(taskId), parked]).then(([, p]) => p);

    // Woken by the stop, not by its own 25s timer.
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(parkedStatus.completed).toBe(true);
    // And told the truth: the task was stopped, not failed.
    expect(parkedStatus.stopReason).toBe('stopped');
  }, 15_000);

  it('killAll stops running tasks and forgets them', async () => {
    const { taskId } = await manager.startTask(sampleParams);
    manager.killAll();
    expect(getRun().stopped).toBe(true);
    // The task has been reaped, so the next readStatus should error.
    await expect(manager.readStatus(taskId)).rejects.toThrow();
  });

  describe('a restart at any moment', () => {
    /** The pending-work payload the manager last recorded for a task. */
    const recorded = () => mockUpdateWork.mock.calls.at(-1)?.[2];

    it('keeps a task as pending work from its start until its end has been read', async () => {
      const { taskId } = await manager.startTask({ prompt: 'fix the build', mode: 'plan' });
      expect(mockBeginWork).toHaveBeenCalledWith('coding-task', taskId, {
        params: { prompt: 'fix the build', mode: 'plan', agent: 'claude-code' },
      });

      getRun().emit({ type: 'session', sessionId: 'session-1' });
      await flush();
      expect(recorded()).toEqual({
        params: { prompt: 'fix the build', mode: 'plan', agent: 'claude-code' },
        sessionId: 'session-1',
        process: { pid: 4242, startedAt: 1_000 },
      });

      getRun().finish(SUCCESS);
      await flush();
      // Kept for its reader with no resume attempt against it, so the bound never drops it.
      expect(mockSettleWork).toHaveBeenCalledWith('coding-task', taskId, {
        params: { prompt: 'fix the build', mode: 'plan', agent: 'claude-code' },
        sessionId: 'session-1',
        finished: { stopReason: 'end_turn', turns: 1, result: 'ok' },
      });
      expect(mockEndWork).not.toHaveBeenCalled();

      await pollUntilComplete(manager, taskId);
      await manager.readStatus(taskId).catch(() => undefined);
      expect(mockEndWork).toHaveBeenCalledWith('coding-task', taskId);
    });

    it('records the process of a run that starts late, before the agent reports a session', async () => {
      const { manager: m, getRun: get } = makeManager({ lateStart: true });
      await m.startTask({ prompt: 'fix the build', mode: 'plan' });
      await flush();
      expect(recorded()).toEqual({ params: { prompt: 'fix the build', mode: 'plan', agent: 'claude-code' } });

      get().start();
      await flush();
      expect(recorded()).toEqual({
        params: { prompt: 'fix the build', mode: 'plan', agent: 'claude-code' },
        process: { pid: 4242, startedAt: 1_000 },
      });
    });

    it('refuses a task it cannot record, and launches nothing', async () => {
      mockBeginWork.mockRejectedValueOnce(new Error('disk full'));

      await expect(manager.startTask(sampleParams)).rejects.toThrow('disk full');

      expect(() => getRun()).toThrow('run not started yet');
      expect(manager.runningCount()).toBe(0);
    });

    it('refuses a task for an agent that is not available, and records nothing', async () => {
      const tasks = new AgentTaskManager(() => {
        throw new Error('Coding agent "codex" is unavailable.');
      });

      await expect(tasks.startTask({ ...sampleParams, agent: 'codex' })).rejects.toThrow('is unavailable');

      expect(mockBeginWork).not.toHaveBeenCalled();
      expect(tasks.runningCount()).toBe(0);
    });

    it('holds a slot for a start that waits for its record', async () => {
      let recordedRow!: () => void;
      mockBeginWork.mockImplementationOnce(() => new Promise<void>((resolve) => { recordedRow = resolve; }));

      const first = manager.startTask(sampleParams);
      for (let i = 1; i < MAX_CONCURRENT; i++) await manager.startTask(sampleParams);
      await expect(manager.startTask(sampleParams)).rejects.toThrow(/Max concurrent/);

      recordedRow();
      await first;
      expect(manager.runningCount()).toBe(MAX_CONCURRENT);
    });

    it('stops owing a task once a read hands out how it ended, also with its last output', async () => {
      const { taskId } = await manager.startTask(sampleParams);
      getRun().emit({ type: 'text', text: 'all done' });
      getRun().finish(SUCCESS);
      await flush();

      const status = await manager.readStatus(taskId, 0);

      expect(status).toMatchObject({ completed: true, output: 'all done' });
      expect(mockEndWork).toHaveBeenCalledWith('coding-task', taskId);
    });

    it('stops owing a task the agent stopped', async () => {
      const { taskId } = await manager.startTask(sampleParams);
      await manager.stopTask(taskId);

      expect(mockEndWork).toHaveBeenCalledWith('coding-task', taskId);
    });

    it('resumes the session of a task a restart stopped, under the same id', async () => {
      await manager.resume([
        {
          key: 'task-7',
          payload: { params: { prompt: 'fix the build', mode: 'edit', agent: 'claude-code' }, sessionId: 'session-1' },
          attempts: 1,
          createdAt: new Date(),
        },
      ]);

      expect(getTask()).toMatchObject({
        taskId: 'task-7',
        sessionId: 'session-1',
        prompt: RESUMED_CODING_TASK_PROMPT,
        mode: 'edit',
      });
      // Until the agent reports a session, the one it resumes stays on the row.
      expect(recorded()).toMatchObject({ sessionId: 'session-1' });
      getRun().emit({ type: 'text', text: 'continuing' });
      getRun().finish(SUCCESS);
      const { output, status } = await pollUntilComplete(manager, 'task-7');
      expect(output).toBe('continuing');
      expect(status.completed).toBe(true);
      // The row keeps what the task was started with, not the resume prompt.
      expect(recorded()).toMatchObject({ params: { prompt: 'fix the build' } });
    });

    it('stops the run a crash left running before it relaunches the task', async () => {
      const mark = { pid: 777, startedAt: 2_000 };
      mockStopLeftover.mockImplementationOnce(async () => {
        expect(() => getRun()).toThrow('run not started yet');
        return true;
      });

      await manager.resume([
        {
          key: 'task-7',
          payload: { params: { prompt: 'fix the build', agent: 'claude-code' }, sessionId: 'session-1', process: mark },
          attempts: 1,
          createdAt: new Date(),
        },
      ]);

      expect(mockStopLeftover).toHaveBeenCalledWith(mark);
      expect(getTask()).toMatchObject({ taskId: 'task-7', sessionId: 'session-1' });
    });

    it("gives a relaunched task the plugins' MCP servers, read before the relaunch", async () => {
      const server = { kind: 'stdio', name: 'search', command: 'search-mcp', args: [], env: {} };
      mockReadPluginConfigs.mockImplementationOnce(async () => {
        mockConfiguredServers.mockReturnValue([{ pluginId: 'docs', server }]);
      });

      await manager.resume([
        { key: 'task-8', payload: { params: { prompt: 'fix the build', agent: 'claude-code' } }, attempts: 1, createdAt: new Date() },
      ]);

      expect(getTask().mcpServers).toContainEqual({ ...server, name: 'docs__search' });
    });

    it('starts a task again when the restart came before it reported a session', async () => {
      await manager.resume([
        {
          key: 'task-8',
          payload: { params: { prompt: 'fix the build', agent: 'claude-code' } },
          attempts: 1,
          createdAt: new Date(),
        },
      ]);

      expect(getTask()).toMatchObject({ taskId: 'task-8', prompt: 'fix the build' });
      expect(getTask().sessionId).toBeUndefined();
    });

    it('continues the other tasks when one cannot continue, and stops owing that one', async () => {
      const runs: string[] = [];
      const tasks = new AgentTaskManager((id) => {
        if (id === 'codex') throw new Error('Coding agent "codex" is unavailable.');
        return {
          id, displayName: id, prepareHome: () => ({ configDir: '', skillsLinked: true }),
          run: (task) => { runs.push(task.taskId); return new FakeRun(); },
        };
      });

      await tasks.resume([
        { key: 'task-codex', payload: { params: { prompt: 'a', agent: 'codex' } }, attempts: 1, createdAt: new Date() },
        { key: 'task-claude', payload: { params: { prompt: 'b', agent: 'claude-code' } }, attempts: 1, createdAt: new Date() },
      ]);

      expect(runs).toEqual(['task-claude']);
      expect(mockEndWork).toHaveBeenCalledWith('coding-task', 'task-codex');
      tasks.killAll();
    });

    it('stops the run of a task the restarts gave up, and relaunches nothing', async () => {
      const mark = { pid: 778, startedAt: 3_000 };

      await manager.resume([], [
        { key: 'task-loop', payload: { params: { prompt: 'fix the build', agent: 'claude-code' }, process: mark }, attempts: 4, createdAt: new Date() },
      ]);

      expect(mockStopLeftover).toHaveBeenCalledWith(mark);
      expect(() => getRun()).toThrow('run not started yet');
    });

    it('reports a finished result after its agent became unavailable', async () => {
      const tasks = new AgentTaskManager(() => {
        throw new Error('Coding agent "codex" is unavailable.');
      });

      await tasks.resume([
        {
          key: 'task-done',
          payload: { params: { prompt: 'fix it', agent: 'codex' }, finished: { result: 'Fixed.', turns: 2, stopReason: 'end_turn' } },
          attempts: 1,
          createdAt: new Date(),
        },
      ]);

      await expect(tasks.readStatus('task-done')).resolves.toMatchObject({ completed: true, result: 'Fixed.', agent: 'codex' });
    });

    it('keeps the refusals of a finished task for its reader', async () => {
      const refusals = [{ action: 'Write', target: '/work/forbidden.txt' }];
      const { taskId } = await manager.startTask(sampleParams);
      getRun().finish({ stopReason: 'end_turn', turns: 2, message: 'done', refusals });
      await flush();

      expect(mockSettleWork).toHaveBeenCalledWith('coding-task', taskId, expect.objectContaining({
        finished: expect.objectContaining({ stopReason: 'refused', refusals }),
      }));
    });

    it('reports the result of a task that ended unread before the restart', async () => {
      await manager.resume([
        {
          key: 'task-9',
          payload: {
            params: { prompt: 'fix the build', agent: 'claude-code' },
            sessionId: 'session-9',
            finished: { result: 'Build fixed.', turns: 4, stopReason: 'end_turn' },
          },
          attempts: 1,
          createdAt: new Date(),
        },
      ]);

      // A result nobody reads counts as an attempt, so the bound drops it.
      expect(mockSettleWork).not.toHaveBeenCalled();
      await expect(manager.readStatus('task-9')).resolves.toMatchObject({
        completed: true,
        result: 'Build fixed.',
        turns: 4,
        sessionId: 'session-9',
      });
      expect(() => getRun()).toThrow('run not started yet');
    });
  });
});

describe('a task started in a chat conversation', () => {
  const target = { threadId: 'thread-1', agentId: 'agent-1', userId: 'user-1', originChannel: 'websocket' };
  let manager: AgentTaskManager;
  let getRun: () => FakeRun;

  beforeEach(() => {
    ({ manager, getRun } = makeManager());
    mockBeginWork.mockResolvedValue(undefined);
    mockDeliver.mockReset().mockResolvedValue(undefined);
    mockEndWork.mockClear();
  });

  it('reports how it ended to that conversation, and the report holds the result', async () => {
    const { taskId } = await manager.startTask({ prompt: 'upgrade React', notify: target });
    getRun().emit({ type: 'session', sessionId: 'session-9' });
    getRun().emit({ type: 'text', text: 'Upgraded; 0 type errors.' });
    getRun().finish({ stopReason: 'end_turn', turns: 7, message: 'ok' });
    await flush();

    expect(mockDeliver).toHaveBeenCalledWith(target, taskId, expect.any(String));
    const text = mockDeliver.mock.calls[0][2] as string;
    expect(text).toContain(`<task-notification task-id="${taskId}" agent="claude-code" stop-reason="end_turn" turns="7" session-id="session-9">`);
    expect(text).toContain('Upgraded; 0 type errors.');
    // The stored report replaces the task: a restart keeps nothing, and a poll after it reads the same end.
    expect(mockEndWork).toHaveBeenCalledWith('coding-task', taskId);
    await expect(manager.readStatus(taskId)).resolves.toMatchObject({
      completed: true,
      stopReason: 'end_turn',
      turns: 7,
      sessionId: 'session-9',
      result: 'Upgraded; 0 type errors.',
    });
  });

  it('reports nothing for a task whose result a poll already handed out', async () => {
    const { taskId } = await manager.startTask({ prompt: 'upgrade React', notify: target });
    const poll = manager.readStatus(taskId, 1_000);
    getRun().finish(SUCCESS);
    expect((await poll).completed).toBe(true);
    await flush();

    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('reports nothing for a task the agent stopped, which answered in the stop', async () => {
    const { taskId } = await manager.startTask({ prompt: 'upgrade React', notify: target });
    await manager.stopTask(taskId);
    await flush();

    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('keeps the task for the next boot when the report cannot be stored', async () => {
    mockDeliver.mockRejectedValue(new Error('database is locked'));
    const { taskId } = await manager.startTask({ prompt: 'upgrade React', notify: target });
    getRun().finish(SUCCESS);
    await flush();

    expect(mockDeliver).toHaveBeenCalledTimes(1);
    expect(mockEndWork).not.toHaveBeenCalled();
    expect(mockSettleWork).toHaveBeenLastCalledWith('coding-task', taskId, expect.objectContaining({
      params: expect.objectContaining({ notify: target }),
      finished: expect.objectContaining({ stopReason: 'end_turn' }),
    }));
  });

  it('sends the report a restart held back', async () => {
    await manager.resume([
      {
        key: 'task-1',
        payload: {
          params: { prompt: 'upgrade React', agent: 'claude-code', notify: target },
          finished: { stopReason: 'end_turn', turns: 2, result: 'Done.' },
        },
        attempts: 1,
      } as never,
    ]);
    await flush();

    expect(mockDeliver).toHaveBeenCalledWith(target, 'task-1', expect.stringContaining('Done.'));
  });

  it('leaves a task without a conversation to its polls', async () => {
    const { taskId } = await manager.startTask({ prompt: 'upgrade React' });
    getRun().finish(SUCCESS);
    await flush();

    expect(mockDeliver).not.toHaveBeenCalled();
    expect((await manager.readStatus(taskId)).result).toBe('ok');
  });
});
