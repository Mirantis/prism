/**
 * Process manager for the generic `shell_spawn` family.
 *
 * In-process map of spawned background processes; the agent uses
 * this to start long-running tasks (e.g. `npm run test`), feed
 * them stdin, drain their stdout/stderr, and kill them.
 *
 * Port of the relevant bits of the upstream Lens Agents shell sandbox's
 * process handlers, minus the cross-process MCP plumbing — agent-runtime
 * calls these directly via AI SDK tools.
 *
 * Concurrency cap is intentionally generous (10) because these are
 * agent-driven background tasks; the cap exists to prevent runaway
 * fork-bomb scenarios, not to gate user concurrency.
 */
import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { logger } from '../../logger';
import { appendCappedChunk } from './exec';
import { sandboxEnv } from './sandbox-env';

export const MAX_PROCESSES = 10;
export const MAX_OUTPUT_BUFFER = 10 * 1024 * 1024; // 10 MiB per stream

interface ProcessState {
  child: ChildProcess;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  stdoutCount: { n: number };
  stderrCount: { n: number };
  stdoutTrunc: { t: boolean };
  stderrTrunc: { t: boolean };
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
}

class ProcessManager {
  private processes = new Map<string, ProcessState>();

  /**
   * Spawn a new background process. Returns the assigned processId.
   */
  spawn(params: {
    command: string;
    workdir: string;
    env?: Record<string, string>;
  }): string {
    if (this.runningCount() >= MAX_PROCESSES) {
      throw new Error(
        `Too many running processes (${this.runningCount()}/${MAX_PROCESSES}). Kill some with shell_kill before spawning more.`,
      );
    }

    const processId = randomUUID();
    // `detached: true` makes the child the leader of its own process
    // group. We can then signal the whole group via process.kill(-pid)
    // — necessary because the shell wrapper would otherwise leave any
    // forked children behind when we kill bash itself.
    const child = spawn('/bin/bash', ['-c', params.command], {
      cwd: params.workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...sandboxEnv(), ...params.env },
      detached: true,
    });

    const state: ProcessState = {
      child,
      stdoutChunks: [],
      stderrChunks: [],
      stdoutCount: { n: 0 },
      stderrCount: { n: 0 },
      stdoutTrunc: { t: false },
      stderrTrunc: { t: false },
      exited: false,
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
    };
    this.processes.set(processId, state);

    child.stdout?.on('data', (chunk: Buffer) =>
      appendCappedChunk(chunk, state.stdoutChunks, state.stdoutCount, state.stdoutTrunc, MAX_OUTPUT_BUFFER),
    );
    child.stderr?.on('data', (chunk: Buffer) =>
      appendCappedChunk(chunk, state.stderrChunks, state.stderrCount, state.stderrTrunc, MAX_OUTPUT_BUFFER),
    );
    // 'exit' fires when the spawned process exits, regardless of
    // whether its stdio pipes are still open (stdio may stay open if
    // grandchildren inherit them). 'close' would block until pipes
    // drain — too late for our running/exit accounting.
    child.on('exit', (code, signal) => {
      state.exited = true;
      state.exitCode = typeof code === 'number' ? code : null;
      state.signal = signal;
    });
    child.on('error', (err) => {
      logger.error({ err, processId }, '[ProcessManager] child error');
    });

    return processId;
  }

  /**
   * Write data to the process's stdin. Throws if the process is
   * not running or its stdin has been closed.
   */
  stdin(processId: string, data: string): void {
    const state = this.processes.get(processId);
    if (!state) throw new Error(`Process ${processId} not found`);
    if (state.exited) throw new Error(`Process ${processId} has already exited`);
    if (!state.child.stdin || state.child.stdin.destroyed) {
      throw new Error(`Process ${processId} stdin is not writable`);
    }
    try {
      state.child.stdin.write(data);
    } catch (err) {
      // The process may have just died between the destroyed check and
      // the write — surface the EPIPE/etc. as a clean error rather than
      // crashing the call site.
      throw new Error(
        `Process ${processId} stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Drain accumulated stdout + stderr. By default returns and clears
   * stdout only; pass `drainStderr` to drain stderr instead.
   * Returns the running flag and exitCode/signal once the process
   * has terminated.
   */
  drain(
    processId: string,
    drainStderr = false,
  ): {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    running: boolean;
    truncated: { stdout: boolean; stderr: boolean };
  } {
    const state = this.processes.get(processId);
    if (!state) throw new Error(`Process ${processId} not found`);

    let stdout = '';
    let stderr = '';
    if (!drainStderr) {
      stdout = Buffer.concat(state.stdoutChunks, state.stdoutCount.n).toString('utf8');
      state.stdoutChunks.length = 0;
      state.stdoutCount.n = 0;
    } else {
      stderr = Buffer.concat(state.stderrChunks, state.stderrCount.n).toString('utf8');
      state.stderrChunks.length = 0;
      state.stderrCount.n = 0;
    }

    const truncated = {
      stdout: state.stdoutTrunc.t,
      stderr: state.stderrTrunc.t,
    };

    const result = {
      stdout,
      stderr,
      exitCode: state.exitCode,
      signal: state.signal,
      running: !state.exited,
      truncated,
    };

    // Reap the entry after the agent reads the post-exit drain. The
    // first such drain still returns a running:false snapshot; any
    // subsequent shell_stdout / shell_kill on this id will report
    // "not found", which is the correct lifecycle signal.
    if (
      state.exited &&
      state.stdoutChunks.length === 0 &&
      state.stderrChunks.length === 0
    ) {
      this.processes.delete(processId);
    }

    return result;
  }

  /**
   * Send a signal to the process group (children of the spawned
   * shell wrapper get the signal too, courtesy of `detached: true`
   * in spawn()). Defaults to SIGTERM.
   */
  kill(processId: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const state = this.processes.get(processId);
    if (!state) return false;
    if (state.exited) return false;
    const pid = state.child.pid;
    if (pid === undefined) return false;
    // Try the process-group route first so any forked grandchildren of
    // the bash wrapper get the signal too. Falls back to a direct
    // child.kill() if the group lookup fails (e.g., environments where
    // detached spawn doesn't establish a new pgid).
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return state.child.kill(signal);
    }
  }

  /**
   * Forget a process record (after termination + final drain).
   * Doesn't kill — call kill() first if needed.
   */
  reap(processId: string): void {
    this.processes.delete(processId);
  }

  /** Number of processes that haven't exited yet. */
  runningCount(): number {
    let n = 0;
    for (const s of this.processes.values()) if (!s.exited) n++;
    return n;
  }

  /** Kill everything (test cleanup). */
  killAll(signal: NodeJS.Signals = 'SIGTERM'): void {
    for (const [id, s] of this.processes) {
      if (!s.exited) s.child.kill(signal);
      this.processes.delete(id);
    }
  }
}

let singleton: ProcessManager | null = null;
export function getProcessManager(): ProcessManager {
  if (!singleton) singleton = new ProcessManager();
  return singleton;
}

/** Test-only: reset the singleton between tests. */
export function __resetProcessManagerForTests(): void {
  if (singleton) singleton.killAll('SIGKILL');
  singleton = null;
}

export type { ProcessManager };
