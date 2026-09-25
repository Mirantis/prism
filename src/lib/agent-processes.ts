/**
 * The processes the agent starts for itself, so a secure takeover can pause them.
 *
 * Every one is started by an execution environment's `runShell` or `runProgram`,
 * and each environment hands the start to `track`. The runtime's own processes —
 * the display, the desktop, the browser, ffmpeg, the container engine's client —
 * are started elsewhere and keep running, since the person typing needs them.
 *
 * SIGSTOP and SIGCONT do the pausing: neither can be caught or ignored, and each
 * process leads its own group, so both reach whatever it forked. A command that
 * starts while the window is open is not started at all until the window closes.
 * In a container each signal is a `docker exec` of its own, so two of them can
 * arrive out of order only for a window shorter than that call, and a person
 * signing in takes far longer.
 */

import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ExecEnd, ExecProcess } from './execution-environments/execution-environment';

/** A start held back by the window, run when it closes. */
interface Deferred {
  start(): void;
}

/**
 * Emits `suspend` and `resume`, so a caller that times its process can stop the
 * clock while the process is stopped.
 */
class AgentProcesses extends EventEmitter {
  private processes = new Set<ExecProcess>();
  private deferred = new Set<Deferred>();
  private suspended = false;
  private exitHooked = false;

  constructor() {
    super();
    // One `suspend` and one `resume` listener per running timed command, each
    // removed when its command ends, so the running commands set the bound.
    this.setMaxListeners(0);
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  get running(): number {
    return this.processes.size;
  }

  /**
   * Start a process on the list. Inside the window the start waits, and the
   * caller gets a process whose streams and outcome are the real one's once it
   * runs.
   */
  track(start: () => ExecProcess, withStdin: boolean): ExecProcess {
    if (!this.suspended) return this.add(start());
    return this.defer(start, withStdin);
  }

  /** Once per window: a command started since the first call already waits. */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    for (const proc of this.processes) proc.kill('SIGSTOP');
    this.emit('suspend');
  }

  resume(): void {
    this.suspended = false;
    for (const proc of this.processes) proc.kill('SIGCONT');
    for (const held of this.deferred) held.start();
    this.deferred.clear();
    this.emit('resume');
  }

  private add(proc: ExecProcess): ExecProcess {
    this.hookExit();
    this.processes.add(proc);
    void proc.ended.then(() => this.processes.delete(proc));
    return proc;
  }

  private defer(start: () => ExecProcess, withStdin: boolean): ExecProcess {
    const stdin = withStdin ? new PassThrough() : null;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let real: ExecProcess | null = null;
    let settle!: (end: ExecEnd) => void;
    let settleClosed!: (end: ExecEnd) => void;
    const ended = new Promise<ExecEnd>((resolve) => (settle = resolve));
    const closed = new Promise<ExecEnd>((resolve) => (settleClosed = resolve));

    const held: Deferred = {
      start: () => {
        real = this.add(start());
        real.stdout?.pipe(stdout);
        real.stderr?.pipe(stderr);
        if (!real.stdout) stdout.end();
        if (!real.stderr) stderr.end();
        if (stdin && real.stdin) stdin.pipe(real.stdin);
        void real.ended.then(settle);
        void real.closed.then(settleClosed);
      },
    };
    this.deferred.add(held);

    return {
      stdin,
      stdout,
      stderr,
      get exitCode() {
        return real?.exitCode ?? null;
      },
      get signal() {
        return real?.signal ?? null;
      },
      ended,
      closed,
      kill: (signal) => {
        if (real) return real.kill(signal);
        // Nothing has run yet: a pause or a continue has nothing to act on, and
        // any other signal ends a process that never started.
        if (signal === 'SIGSTOP' || signal === 'SIGCONT') return true;
        this.deferred.delete(held);
        stdout.end();
        stderr.end();
        const end: ExecEnd = { exitCode: null, signal, error: null };
        settle(end);
        settleClosed(end);
        return true;
      },
    };
  }

  /**
   * Kill every process on the list when the runtime exits. Each leads a group of
   * its own, so it outlives the runtime otherwise, and one stopped by a takeover
   * would stay stopped for good. SIGKILL reaches a stopped process.
   */
  private hookExit(): void {
    if (this.exitHooked) return;
    this.exitHooked = true;
    process.once('exit', () => {
      for (const proc of this.processes) proc.kill('SIGKILL');
    });
  }
}

export const agentProcesses = new AgentProcesses();
