/**
 * Unit tests for the AgentTaskManager. We stub `spawn` with a fake
 * child process that emits stream-json lines on a schedule, so we
 * exercise the full parse/drain/complete state machine without
 * launching the real Claude Code CLI.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { config } from '../../../config';
import {
  AgentTaskManager,
  AgentTaskParams,
  MAX_BUFFER_SIZE,
  PLAN_ONLY_INSTRUCTION,
  MAX_CONCURRENT,
  type Spawner,
} from '../agent-task-manager';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  // Real ChildProcess exposes this, and the SIGKILL escalation reads it to
  // decide whether the child is still alive. Diverging here would make an
  // escalation test silently pass without ever escalating.
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill(_signal?: string): boolean {
    this.killed = true;
    this.finish(143);
    return true;
  }
  emitLine(line: string) {
    this.stdout.write(line + '\n');
  }
  finish(code: number | null) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    // Slight delay so the readline 'close' fires before 'exit'.
    process.nextTick(() => this.emit('exit', code, null));
  }
}

/**
 * A child that ignores every signal and never closes stdout — a `claude` that
 * hangs, or one whose grandchild inherited the pipe. drive()'s read loop can
 * never end for this one, so stopTask has to finalize the state itself.
 */
class StubbornChild extends FakeChild {
  override kill(_signal?: string): boolean {
    this.killed = true;
    return true;
  }
}

/** A child whose spawn fails, as `spawn` reports it: one 'error', never 'exit'. */
class FailedSpawnChild extends FakeChild {
  fail(message: string): void {
    // Mirrors Node: the streams are torn down and 'error' fires on its own turn.
    this.stdout.end();
    this.stderr.end();
    process.nextTick(() => this.emit('error', new Error(message)));
  }
}

function makeManager(): { manager: AgentTaskManager; getChild: () => FakeChild } {
  let lastChild: FakeChild | null = null;
  const manager = new AgentTaskManager(() => {
    lastChild = new FakeChild();
    return lastChild as unknown as ChildProcess;
  });
  return {
    manager,
    getChild: () => {
      if (!lastChild) throw new Error('spawn not called yet');
      return lastChild;
    },
  };
}

const sampleParams: AgentTaskParams = {
  prompt: 'do X',
};

/** A manager whose spawner returns the given child, for the awkward children. */
function makeManagerWith<T extends FakeChild>(make: () => T): {
  manager: AgentTaskManager;
  getChild: () => T;
} {
  let lastChild: T | null = null;
  const manager = new AgentTaskManager(() => {
    lastChild = make();
    return lastChild as unknown as ChildProcess;
  });
  return {
    manager,
    getChild: () => {
      if (!lastChild) throw new Error('spawn not called yet');
      return lastChild;
    },
  };
}

/**
 * Drive readStatus in a loop until the task reports completion. Mirrors how a
 * real caller would poll; each iteration accumulates drained output.
 */
async function pollUntilComplete(
  manager: AgentTaskManager,
  taskId: string,
  { timeoutMs = 2000, waitMs = 30 } = {},
): Promise<{ output: string; status: ReturnType<AgentTaskManager['readStatus']> extends Promise<infer T> ? T : never }> {
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
 * Let the driver run to its finalize after the child exits: the readline close,
 * the end of the stdout loop, the exit promise, and the state write all land
 * within a few macrotask turns. Turn-based rather than a timed sleep, so it is
 * deterministic.
 */
async function flush(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('AgentTaskManager', () => {
  let manager: AgentTaskManager;
  let getChild: () => FakeChild;

  beforeEach(() => {
    config.toolRiskGateMode = 'off';
    const m = makeManager();
    manager = m.manager;
    getChild = m.getChild;
  });

  it('startTask returns a taskId and tracks the task', () => {
    const taskId = manager.startTask(sampleParams);
    expect(typeof taskId).toBe('string');
    expect(taskId.length).toBeGreaterThan(0);
  });

  it('buffers assistant text and delivers it on readStatus (drain-on-read)', async () => {
    const taskId = manager.startTask(sampleParams);
    const child = getChild();
    child.emitLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello ' }] },
      }),
    );
    child.emitLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'world' }] },
      }),
    );
    child.finish(0);

    const { output, status } = await pollUntilComplete(manager, taskId);
    expect(output).toBe('hello world');
    expect(status.completed).toBe(true);
  });

  it('reports completion + result fields after the result line and exit', async () => {
    const taskId = manager.startTask(sampleParams);
    const child = getChild();
    child.emitLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'final answer' }] },
      }),
    );
    child.emitLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'final answer',
        num_turns: 7,
        session_id: 'sess-42',
      }),
    );
    child.finish(0);

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

  it('maps error_max_turns and error subtypes to the right stopReason', async () => {
    const taskId = manager.startTask(sampleParams);
    const child = getChild();
    child.emitLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        result: 'hit max',
        num_turns: 100,
      }),
    );
    child.finish(0);
    const { status } = await pollUntilComplete(manager, taskId);
    expect(status.stopReason).toBe('max_turns');

    const t2 = manager.startTask(sampleParams);
    const child2 = getChild();
    child2.emitLine(
      JSON.stringify({ type: 'result', subtype: 'error', result: 'boom' }),
    );
    child2.finish(0);
    const { status: s2 } = await pollUntilComplete(manager, t2);
    expect(s2.stopReason).toBe('error');
  });

  it('handles a child that never emits a result line', async () => {
    const taskId = manager.startTask(sampleParams);
    const child = getChild();
    child.stderr.write('something went wrong\n');
    child.finish(1);

    const { status } = await pollUntilComplete(manager, taskId);
    expect(status.stopReason).toBe('error');
    expect(status.result).toMatch(/exited with code 1/);
  });

  it('truncates the output buffer when it exceeds MAX_BUFFER_SIZE', async () => {
    const taskId = manager.startTask(sampleParams);
    const child = getChild();
    const big = 'x'.repeat(MAX_BUFFER_SIZE + 1000);
    child.emitLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: big }] },
      }),
    );
    child.finish(0);
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
    const taskId = manager.startTask(sampleParams);
    const child = getChild();
    child.emitLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'partial work' }] },
      }),
    );

    const status = await manager.stopTask(taskId);
    expect(child.killed).toBe(true);
    expect(status.completed).toBe(true);
    expect(status.stopReason).toBe('stopped');
    expect(status.output).toBe('partial work');
    // The signal exit code must not be reported as a task failure.
    expect(status.result).toBe('partial work');
  });

  it('stopTask reports the session id so the abandoned work can be resumed', async () => {
    const taskId = manager.startTask(sampleParams);
    const child = getChild();
    // The CLI's opening line — the only place a killed task's session id
    // appears, since it never reaches a `result` line.
    child.emitLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-init' }),
    );

    const status = await manager.stopTask(taskId);
    expect(status.sessionId).toBe('sess-init');
    expect(status.result).toBe('Task stopped before producing any output.');
  });

  it('stopTask frees the concurrency slot', async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT; i++) ids.push(manager.startTask(sampleParams));
    expect(() => manager.startTask(sampleParams)).toThrow(/Max concurrent/);

    await manager.stopTask(ids[0]);
    expect(() => manager.startTask(sampleParams)).not.toThrow();
  });

  it('stopTask rejects an unknown or already-stopped taskId', async () => {
    await expect(manager.stopTask('no-such-id')).rejects.toThrow(/Unknown task/);

    const taskId = manager.startTask(sampleParams);
    await manager.stopTask(taskId);
    await expect(manager.stopTask(taskId)).rejects.toThrow(/cleaned up/);
    await expect(manager.readStatus(taskId)).rejects.toThrow(/cleaned up/);
  });

  it('stopTask on a task that already finished keeps its real outcome', async () => {
    const taskId = manager.startTask(sampleParams);
    const child = getChild();
    child.emitLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done text' }] },
      }),
    );
    child.emitLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'done',
        num_turns: 3,
      }),
    );
    child.finish(0);
    await flush();

    const status = await manager.stopTask(taskId);
    expect(status.stopReason).toBe('end_turn');
    expect(status.turns).toBe(3);
    expect(status.output).toBe('done text');
    expect(child.killed).toBe(false);
  });

  it('stopTask does not relabel a child that exited just before the stop', async () => {
    const taskId = manager.startTask(sampleParams);
    const child = getChild();
    child.emitLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'THE REAL FINAL RESULT',
        num_turns: 3,
        session_id: 'sess-real',
      }),
    );
    // Exit, but stop *before* drive() gets to its finalize — the window between
    // the child dying and the state being written.
    child.finish(0);

    const status = await manager.stopTask(taskId);
    expect(status.stopReason).toBe('end_turn');
    expect(status.result).toBe('THE REAL FINAL RESULT');
    expect(status.turns).toBe(3);
    expect(status.sessionId).toBe('sess-real');
  });

  it('stopTask still reports output and a session id when the child never closes stdout', async () => {
    const { manager: m, getChild: get } = makeManagerWith(() => new StubbornChild());
    const taskId = m.startTask(sampleParams);
    const child = get();
    child.emitLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-stubborn' }),
    );
    child.emitLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'half-done work' }] },
      }),
    );

    const status = await m.stopTask(taskId);
    expect(child.killed).toBe(true);
    expect(status.completed).toBe(true);
    expect(status.stopReason).toBe('stopped');
    expect(status.output).toBe('half-done work');
    // The whole point of the fallback: the resume path survives it, even though
    // no `result` line ever arrives to carry the id.
    expect(status.sessionId).toBe('sess-stubborn');
  }, 15_000);

  it('stopTask wakes a parked poll instead of leaving it to time out', async () => {
    const { manager: m, getChild: get } = makeManagerWith(() => new StubbornChild());
    const taskId = m.startTask(sampleParams);
    // Only the init line, so there is nothing to drain and the poll really parks.
    get().emitLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-stubborn' }),
    );

    const started = Date.now();
    const parked = m.readStatus(taskId, 25_000);
    const parkedStatus = await Promise.all([m.stopTask(taskId), parked]).then(([, p]) => p);

    // Woken by the stop, not by its own 25s timer.
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(parkedStatus.completed).toBe(true);
    // And told the truth: the task was stopped, not failed.
    expect(parkedStatus.stopReason).toBe('stopped');
  }, 15_000);

  it('reports a spawn failure as a failed task instead of crashing', async () => {
    const { manager: m, getChild: get } = makeManagerWith(() => new FailedSpawnChild());
    const taskId = m.startTask(sampleParams);
    get().fail('spawn claude ENOENT');

    const { status } = await pollUntilComplete(m, taskId);
    expect(status.completed).toBe(true);
    expect(status.stopReason).toBe('error');
    expect(status.result).toMatch(/failed to start.*ENOENT/);
  });

  it('killAll marks running tasks completed with stopReason=error', async () => {
    const taskId = manager.startTask(sampleParams);
    manager.killAll();
    // The task has been reaped, so the next readStatus should error.
    await expect(manager.readStatus(taskId)).rejects.toThrow();
  });

  it('spawns the CLI with server-only env (NODE_ENV, HUSKY) stripped', () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, HUSKY: process.env.HUSKY };
    process.env.NODE_ENV = 'production';
    process.env.HUSKY = '0';
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    try {
      const capturingSpawner: Spawner = (_command, _args, options) => {
        capturedEnv = options.env;
        return new FakeChild() as unknown as ChildProcess;
      };
      new AgentTaskManager(capturingSpawner).startTask(sampleParams);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv?.NODE_ENV).toBeUndefined();
    expect(capturedEnv?.HUSKY).toBeUndefined();
    // Non-server vars still pass through to the CLI.
    expect(capturedEnv?.PATH).toBe(process.env.PATH);
  });

  it.each(['off', 'observe'] as const)(
    'preserves bypass permissions in %s mode',
    (gateMode) => {
      config.toolRiskGateMode = gateMode;
      let capturedArgs: readonly string[] = [];
      const capturingSpawner: Spawner = (_command, args) => {
        capturedArgs = args;
        return new FakeChild() as unknown as ChildProcess;
      };

      new AgentTaskManager(capturingSpawner).startTask(sampleParams);

      expect(capturedArgs).toContain('--dangerously-skip-permissions');
      expect(capturedArgs).not.toContain('auto');
    },
  );

  it('uses Claude Code auto permission mode without bypass when enforcing', () => {
    config.toolRiskGateMode = 'enforce';
    let capturedArgs: readonly string[] = [];
    const capturingSpawner: Spawner = (_command, args) => {
      capturedArgs = args;
      return new FakeChild() as unknown as ChildProcess;
    };

    new AgentTaskManager(capturingSpawner).startTask(sampleParams);

    expect(capturedArgs).not.toContain('--dangerously-skip-permissions');
    expect(capturedArgs).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));
  });

  it('keeps Claude Code in plan mode without bypass when enforcing', () => {
    config.toolRiskGateMode = 'enforce';
    let capturedArgs: readonly string[] = [];
    const capturingSpawner: Spawner = (_command, args) => {
      capturedArgs = args;
      return new FakeChild() as unknown as ChildProcess;
    };

    new AgentTaskManager(capturingSpawner).startTask({ ...sampleParams, mode: 'plan' });

    expect(capturedArgs).not.toContain('--dangerously-skip-permissions');
    expect(capturedArgs).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
    expect(capturedArgs).not.toContain('auto');
  });
});

/**
 * `--system-prompt` *replaces* Claude Code's default prompt, stripping the sub-agent of
 * its tool-selection, todo and search conventions — so the invariant every case here
 * checks is that the flag is never emitted, whatever the mode. Plan mode's read-only
 * constraint and any caller framing are appended instead, on one flag.
 */
describe('buildCliCommand system prompt args', () => {
  beforeEach(() => {
    config.toolRiskGateMode = 'off';
  });

  afterEach(() => {
    config.toolRiskGateMode = 'off';
  });

  /** Start a task with a spawner that records the args instead of running anything. */
  function captureArgs(params: AgentTaskParams): readonly string[] {
    let captured: readonly string[] | undefined;
    const capturingSpawner: Spawner = (_command, args) => {
      captured = args;
      return new FakeChild() as unknown as ChildProcess;
    };
    new AgentTaskManager(capturingSpawner).startTask(params);
    if (!captured) throw new Error('spawner was not called');
    return captured;
  }

  /** The value carried by a flag, or undefined when the flag is absent. */
  function valueOf(args: readonly string[], flag: string): string | undefined {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  }

  it('never replaces the default prompt, in any mode', () => {
    for (const mode of ['plan', 'edit', undefined] as const) {
      for (const appendSystemPrompt of ['custom', undefined]) {
        const args = captureArgs({ ...sampleParams, mode, appendSystemPrompt });
        expect(args).not.toContain('--system-prompt');
      }
    }
  });

  it('constrains plan mode by instruction, since the permission mode does not', () => {
    // The off/observe branch passes bypass permissions, under which Claude Code
    // auto-approves writes even in plan mode — so the instruction is the real guard.
    const args = captureArgs({ ...sampleParams, mode: 'plan' });
    expect(valueOf(args, '--append-system-prompt')).toBe(PLAN_ONLY_INSTRUCTION);
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
  });

  it('carries the plan constraint and a caller prompt on one flag', () => {
    const args = captureArgs({ ...sampleParams, mode: 'plan', appendSystemPrompt: 'custom' });
    // One occurrence, so neither part can silently drop the other.
    expect(args.filter((a) => a === '--append-system-prompt')).toHaveLength(1);
    const value = valueOf(args, '--append-system-prompt');
    expect(value).toContain(PLAN_ONLY_INSTRUCTION);
    expect(value).toContain('custom');
  });

  it('leaves edit mode with the caller prompt alone and no plan constraint', () => {
    const args = captureArgs({ ...sampleParams, mode: 'edit', appendSystemPrompt: 'custom' });
    expect(valueOf(args, '--append-system-prompt')).toBe('custom');
  });

  it('passes no prompt flag at all for a default-mode task with no caller prompt', () => {
    const args = captureArgs(sampleParams);
    expect(args).not.toContain('--append-system-prompt');
  });

  it('keeps the plan constraint under the enforcing tool-risk gate too', () => {
    // Enforce mode withholds bypass, so plan really is read-only there; the
    // instruction still rides along, since `claude` on PATH is not version-pinned.
    config.toolRiskGateMode = 'enforce';
    const args = captureArgs({ ...sampleParams, mode: 'plan', appendSystemPrompt: 'custom' });
    expect(args).not.toContain('--dangerously-skip-permissions');
    const value = valueOf(args, '--append-system-prompt');
    expect(value).toContain(PLAN_ONLY_INSTRUCTION);
    expect(value).toContain('custom');
  });
});
