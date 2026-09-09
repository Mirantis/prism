/**
 * Unit tests for the AgentTaskManager. A scripted fake `CodingAgent` stands in
 * for the real adapter, so these exercise the buffer/drain/complete/stop state
 * machine on the neutral events every adapter emits, without a child process.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { config } from '../../../config';
import { codingAgentInput, runCodingAgent } from '../coding-agent';

import { AsyncChannel } from '../../../utils/async-channel';
import type {
  CodingAgent,
  CodingAgentEvent,
  CodingAgentRun,
  CodingAgentTask,
} from '../../../lib/coding-agents/coding-agent';
import {
  AgentTaskManager,
  __setAgentTaskManagerForTests,
  AgentTaskParams,
  DEFAULT_MAX_TURNS,
  MAX_BUFFER_SIZE,
  MAX_CONCURRENT,
} from '../agent-task-manager';

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

  constructor(private readonly stubborn = false) {}

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

function makeManager({ stubborn = false } = {}): {
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
      lastRun = new FakeRun(stubborn);
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
      const defaultTask = tasks.startTask(sampleParams);
      const explicitTask = tasks.startTask({ ...sampleParams, agent: 'claude-code' });
      const thirdTask = tasks.startTask({ ...sampleParams, agent: 'codex' });
      expect([defaultTask.agent, explicitTask.agent, thirdTask.agent]).toEqual(['codex', 'claude-code', 'codex']);
      expect(resolve.mock.calls.map(([id]) => id)).toEqual(['codex', 'claude-code', 'codex']);
      expect(() => tasks.startTask({ ...sampleParams, agent: 'claude-code' }))
        .toThrow('Max concurrent agent tasks');
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
      const input = codingAgentInput.parse({ prompt: 'do X', model: 'small', effort: 'low', sessionId });
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
      await runCodingAgent(codingAgentInput.parse({ prompt: 'do X' }), '/work');
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
    expect(codingAgentInput.safeParse({ prompt: 'do X', ...params }).success).toBe(false);
  });

  it.each(['small', 'medium', 'large'])('accepts %s with every effort', (model) => {
    for (const effort of ['low', 'medium', 'high']) {
      expect(codingAgentInput.parse({ prompt: 'do X', model, effort })).toMatchObject({ model, effort });
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

  it('startTask returns a taskId and tracks the task', () => {
    const { taskId } = manager.startTask(sampleParams);
    expect(typeof taskId).toBe('string');
    expect(taskId.length).toBeGreaterThan(0);
    expect(manager.runningCount()).toBe(1);
  });

  it('hands the agent the task inputs and the sandbox environment', () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, HUSKY: process.env.HUSKY };
    process.env.NODE_ENV = 'production';
    process.env.HUSKY = '0';
    let taskId: string;
    try {
      ({ taskId } = manager.startTask({
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
      gateMode: config.toolRiskGateMode,
    });
    // Server-only vars are stripped; everything else passes through.
    expect(task.env.NODE_ENV).toBeUndefined();
    expect(task.env.HUSKY).toBeUndefined();
    expect(task.env.PATH).toBe(process.env.PATH);
  });

  it('defaults to edit mode and the standard turn budget', () => {
    manager.startTask(sampleParams);
    expect(getTask()).toMatchObject({ mode: 'edit', maxTurns: DEFAULT_MAX_TURNS });
  });

  it('buffers text and delivers it on readStatus (drain-on-read)', async () => {
    const { taskId } = manager.startTask(sampleParams);
    const run = getRun();
    run.emit({ type: 'text', text: 'hello ' });
    run.emit({ type: 'text', text: 'world' });
    run.finish(SUCCESS);

    const { output, status } = await pollUntilComplete(manager, taskId);
    expect(output).toBe('hello world');
    expect(status.completed).toBe(true);
  });

  it('reports completion + result fields once the run ends', async () => {
    const { taskId } = manager.startTask(sampleParams);
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

    // After completion is delivered once + the next empty read, the task is
    // reaped and subsequent lookups error.
    await expect(manager.readStatus(taskId)).rejects.toThrow(/cleaned up/);
  });

  it("uses the agent's message as the result when it produced no text", async () => {
    const { taskId } = manager.startTask(sampleParams);
    getRun().finish({ stopReason: 'end_turn', turns: 2, message: 'summary' });
    const { status } = await pollUntilComplete(manager, taskId);
    expect(status.result).toBe('summary');
  });

  it('appends a non-success outcome to the text it produced', async () => {
    const { taskId } = manager.startTask(sampleParams);
    const run = getRun();
    run.emit({ type: 'text', text: 'partial' });
    run.finish({ stopReason: 'max_turns', turns: 100, message: 'hit max' });

    const { status } = await pollUntilComplete(manager, taskId);
    expect(status.stopReason).toBe('max_turns');
    expect(status.result).toBe('partial\n\n[max_turns]: hit max');
  });

  it('reports a non-success outcome with no text as an error', async () => {
    const { taskId } = manager.startTask(sampleParams);
    getRun().finish({ stopReason: 'error', turns: 0, message: 'boom' });

    const { status } = await pollUntilComplete(manager, taskId);
    expect(status.stopReason).toBe('error');
    expect(status.result).toBe('Error (error): boom');
  });

  it('fails a task whose run ends without reporting a result', async () => {
    const { taskId } = manager.startTask(sampleParams);
    getRun().end();

    const { status } = await pollUntilComplete(manager, taskId);
    expect(status.stopReason).toBe('error');
    expect(status.result).toMatch(/Fake Agent ended without reporting a result/);
  });

  it('truncates the output buffer when it exceeds MAX_BUFFER_SIZE', async () => {
    const { taskId } = manager.startTask(sampleParams);
    const run = getRun();
    run.emit({ type: 'text', text: 'x'.repeat(MAX_BUFFER_SIZE + 1000) });
    run.finish(SUCCESS);

    const { output } = await pollUntilComplete(manager, taskId);
    expect(output.startsWith('[...output truncated...]\n')).toBe(true);
    // ~1 MiB payload plus the truncation marker.
    expect(output.length).toBeLessThanOrEqual(MAX_BUFFER_SIZE + 64);
  });

  it('enforces MAX_CONCURRENT on startTask', () => {
    for (let i = 0; i < MAX_CONCURRENT; i++) manager.startTask(sampleParams);
    expect(() => manager.startTask(sampleParams)).toThrow(/Max concurrent/);
  });

  it('readStatus on an unknown taskId throws', async () => {
    await expect(manager.readStatus('no-such-id')).rejects.toThrow(/Unknown task/);
  });

  it('stopTask terminates a running task and returns the output so far', async () => {
    const { taskId } = manager.startTask(sampleParams);
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
    const { taskId } = manager.startTask(sampleParams);
    // The agent announces its session early — the only place a killed task's
    // session id appears, since it never reaches a final result.
    getRun().emit({ type: 'session', sessionId: 'sess-init' });

    const status = await manager.stopTask(taskId);
    expect(status.sessionId).toBe('sess-init');
    expect(status.result).toBe('Task stopped before producing any output.');
  });

  it('stopTask frees the concurrency slot', async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT; i++) ids.push(manager.startTask(sampleParams).taskId);
    expect(() => manager.startTask(sampleParams)).toThrow(/Max concurrent/);

    await manager.stopTask(ids[0]);
    expect(() => manager.startTask(sampleParams)).not.toThrow();
  });

  it('stopTask rejects an unknown or already-stopped taskId', async () => {
    await expect(manager.stopTask('no-such-id')).rejects.toThrow(/Unknown task/);

    const { taskId } = manager.startTask(sampleParams);
    await manager.stopTask(taskId);
    await expect(manager.stopTask(taskId)).rejects.toThrow(/cleaned up/);
    await expect(manager.readStatus(taskId)).rejects.toThrow(/cleaned up/);
  });

  it('stopTask on a task that already finished keeps its real outcome', async () => {
    const { taskId } = manager.startTask(sampleParams);
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
    const { taskId } = manager.startTask(sampleParams);
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
    const { taskId } = m.startTask(sampleParams);
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
    const { taskId } = m.startTask(sampleParams);
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
    const { taskId } = manager.startTask(sampleParams);
    manager.killAll();
    expect(getRun().stopped).toBe(true);
    // The task has been reaped, so the next readStatus should error.
    await expect(manager.readStatus(taskId)).rejects.toThrow();
  });
});
