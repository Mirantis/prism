/**
 * Unit tests for the AgentTaskManager. We stub `spawn` with a fake
 * child process that emits stream-json lines on a schedule, so we
 * exercise the full parse/drain/complete state machine without
 * launching the real Claude Code CLI.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import {
  AgentTaskManager,
  AgentTaskParams,
  MAX_BUFFER_SIZE,
  MAX_CONCURRENT,
} from '../agent-task-manager';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
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

describe('AgentTaskManager', () => {
  let manager: AgentTaskManager;
  let getChild: () => FakeChild;

  beforeEach(() => {
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

  it('killAll marks running tasks completed with stopReason=error', async () => {
    const taskId = manager.startTask(sampleParams);
    manager.killAll();
    // The task has been reaped, so the next readStatus should error.
    await expect(manager.readStatus(taskId)).rejects.toThrow();
  });
});
