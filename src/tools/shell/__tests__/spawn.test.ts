/**
 * Behavior tests for the shell_spawn family. Uses real subprocesses
 * (cat, sleep, sh) so we exercise the actual ChildProcess + stdio
 * pipeline. Each test owns its workspace tmp dir.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  runShellSpawn,
  runShellStdin,
  runShellStdout,
  runShellKill,
} from '../spawn';
import { __resetProcessManagerForTests, getProcessManager } from '../process-manager';

let workspace: string;

beforeAll(async () => {
  workspace = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'spawn-tools-test-')),
  );
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  __resetProcessManagerForTests();
});

afterEach(() => {
  __resetProcessManagerForTests();
});

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('shell_spawn family', () => {
  it('round-trips stdin → stdout via cat', async () => {
    const { processId } = await runShellSpawn({ command: 'cat' }, workspace);
    expect(processId).toBeTruthy();

    const stdinResult = await runShellStdin({ processId, data: 'hello\n' });
    expect(stdinResult).toEqual({ ok: true });

    // cat echoes input; wait for it to land in the buffer.
    await waitFor(() => {
      const peek = (
        getProcessManager() as unknown as {
          processes: Map<string, { stdoutCount: { n: number } }>;
        }
      ).processes
        .get(processId)
        ?.stdoutCount.n;
      return (peek ?? 0) > 0;
    });

    const drained = await runShellStdout({ processId });
    expect('error' in drained).toBe(false);
    if (!('error' in drained)) {
      expect(drained.stdout).toBe('hello\n');
      expect(drained.running).toBe(true);
    }

    await runShellKill({ processId });
  });

  it('does not leak server-only env (NODE_ENV, HUSKY) into spawned processes', async () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, HUSKY: process.env.HUSKY };
    process.env.NODE_ENV = 'production';
    process.env.HUSKY = '0';
    try {
      const { processId } = await runShellSpawn(
        { command: 'echo "[$NODE_ENV][$HUSKY]"' },
        workspace,
      );
      await waitFor(() => {
        const exit = (
          getProcessManager() as unknown as {
            processes: Map<string, { exitCode: number | null }>;
          }
        ).processes.get(processId)?.exitCode;
        return exit !== null && exit !== undefined;
      });
      const drained = await runShellStdout({ processId });
      if ('error' in drained) throw new Error(drained.error);
      expect(drained.stdout.trim()).toBe('[][]');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('captures exitCode after the process exits', async () => {
    const { processId } = await runShellSpawn(
      { command: 'sh -c "echo done; exit 7"' },
      workspace,
    );

    await waitFor(() => {
      const exit = (
        getProcessManager() as unknown as {
          processes: Map<string, { exitCode: number | null }>;
        }
      ).processes.get(processId)?.exitCode;
      return exit !== null && exit !== undefined;
    });

    const drained = await runShellStdout({ processId });
    if ('error' in drained) throw new Error(drained.error);
    expect(drained.stdout.trim()).toBe('done');
    expect(drained.running).toBe(false);
    expect(drained.exitCode).toBe(7);
  });

  it('drains stderr separately when drainStderr is true', async () => {
    const { processId } = await runShellSpawn(
      { command: 'sh -c "echo out; echo err >&2"' },
      workspace,
    );

    await waitFor(() => {
      const s = (
        getProcessManager() as unknown as {
          processes: Map<string, { exitCode: number | null }>;
        }
      ).processes.get(processId)?.exitCode;
      return s === 0;
    });

    const out = await runShellStdout({ processId });
    if ('error' in out) throw new Error(out.error);
    expect(out.stdout.trim()).toBe('out');
    expect(out.stderr).toBe('');

    const err = await runShellStdout({ processId, drainStderr: true });
    if ('error' in err) throw new Error(err.error);
    expect(err.stderr.trim()).toBe('err');
  });

  it('SIGKILL terminates a running process', async () => {
    const { processId } = await runShellSpawn({ command: 'sleep 30' }, workspace);
    const killResult = await runShellKill({ processId, signal: 'SIGKILL' });
    expect(killResult).toEqual({ ok: true });
    await waitFor(() => {
      const s = (
        getProcessManager() as unknown as {
          processes: Map<string, { exited: boolean }>;
        }
      ).processes.get(processId);
      return s?.exited === true;
    }, 3000);
  });

  it('drops the process from runningCount after SIGKILL', async () => {
    const { processId } = await runShellSpawn({ command: 'sleep 30' }, workspace);
    expect(getProcessManager().runningCount()).toBe(1);
    await runShellKill({ processId, signal: 'SIGKILL' });
    await waitFor(() => getProcessManager().runningCount() === 0, 3000);
  });

  it('reaps the entry on the next drain after exit', async () => {
    const { processId } = await runShellSpawn({ command: 'sleep 30' }, workspace);
    await runShellKill({ processId, signal: 'SIGKILL' });
    await waitFor(() => {
      const s = (
        getProcessManager() as unknown as {
          processes: Map<string, { exited: boolean }>;
        }
      ).processes.get(processId);
      return s?.exited === true;
    }, 3000);
    // First drain after exit: returns final state then reaps.
    const drained = await runShellStdout({ processId });
    expect('error' in drained).toBe(false);
    if (!('error' in drained)) expect(drained.running).toBe(false);
    // Subsequent drain: process is gone.
    const second = await runShellStdout({ processId });
    expect('error' in second).toBe(true);
  });

  it('does not reap on kill — process stays tracked until it actually exits', async () => {
    // Regression for the previous bug where runShellKill reaped the
    // entry immediately, letting a process that ignored the signal
    // bypass MAX_PROCESSES. Now: kill leaves the entry in the map;
    // the natural exit handler clears it.
    const { processId } = await runShellSpawn({ command: 'sleep 30' }, workspace);
    expect(getProcessManager().runningCount()).toBe(1);
    await runShellKill({ processId, signal: 'SIGKILL' });
    // Immediately after kill, before the OS has reaped the child,
    // the entry must still exist in the map.
    const stillTracked = (
      getProcessManager() as unknown as {
        processes: Map<string, unknown>;
      }
    ).processes.has(processId);
    expect(stillTracked).toBe(true);
    // Eventually the exit handler fires and runningCount reaches 0.
    await waitFor(() => getProcessManager().runningCount() === 0, 3000);
  });

  it('returns ok:false when killing an unknown processId', async () => {
    const result = await runShellKill({ processId: 'nope' });
    expect(result).toEqual({ ok: false });
  });

  it('errors on stdin to an unknown process', async () => {
    const result = await runShellStdin({ processId: 'nope', data: 'x' });
    expect('error' in result).toBe(true);
  });

  it('caps each spawn within MAX_PROCESSES', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { processId } = await runShellSpawn({ command: 'sleep 30' }, workspace);
      ids.push(processId);
    }
    await expect(
      runShellSpawn({ command: 'sleep 30' }, workspace),
    ).rejects.toThrow(/Too many running processes/);
    for (const id of ids) await runShellKill({ processId: id });
  });
});
