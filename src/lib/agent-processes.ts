/**
 * The processes the agent starts for itself: `shell_exec`, `shell_spawn`, and a
 * coding agent's CLI. This implementation must be used whenever processes are
 * started, so that we can pause them during a secure takeover.
 *
 * SIGSTOP and SIGCONT do the pausing: neither can be caught or ignored, and each
 * child leads its own process group, so both reach whatever it forked. A command
 * that starts while the window is open waits at the gate below instead of running.
 *
 * The runtime's own processes — the display, the desktop, the browser, ffmpeg —
 * are not started here and keep running, since the person typing needs them.
 */

import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from 'child_process';
import { EventEmitter } from 'events';
import type { Writable } from 'stream';
import { logger } from '../logger';

/**
 * What a command started inside the window runs instead of running itself: the shell
 * waits for the parent to close the pipe on fd 3, then replaces itself with the
 * program. Nothing of the program runs until the window closes.
 */
const WAIT_FOR_START = 'read -r _ <&3 || true; exec 3<&-; exec "$0" "$@"';

/** The caller's stdio, with the gate's pipe added as fd 3. */
function stdioWithGate(stdio: StdioOptions | undefined): StdioOptions {
  const given = Array.isArray(stdio) ? [...stdio] : [stdio ?? 'pipe', stdio ?? 'pipe', stdio ?? 'pipe'];
  while (given.length < 3) given.push('pipe');
  return [...given, 'pipe'] as StdioOptions;
}

/**
 * Emits `suspend` and `resume`, so a caller that times its child can stop the clock
 * while the child is stopped.
 */
class AgentProcesses extends EventEmitter {
  private children = new Set<ChildProcess>();
  /** Children waiting on the gate, which opens when the window closes. */
  private waiting = new Set<ChildProcess>();
  private suspended = false;
  private exitHooked = false;

  constructor() {
    super();
    // One `suspend` and one `resume` listener per running `shell_exec`, each removed
    // when its command ends, so the running commands set the bound.
    this.setMaxListeners(0);
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  /** `spawn`, with the child in its own process group and on the list. */
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
    // A command that starts inside the window — the tool call of a step already in
    // flight — waits at the gate instead of running.
    const child = this.suspended
      ? spawn('/bin/sh', ['-c', WAIT_FOR_START, command, ...args], {
          ...options,
          stdio: stdioWithGate(options.stdio),
          detached: true,
        })
      : spawn(command, args as string[], { ...options, detached: true });
    if (child.pid === undefined) return child;
    this.hookExit();
    this.children.add(child);
    if (this.suspended) this.waiting.add(child);
    child.once('exit', () => {
      this.children.delete(child);
      this.waiting.delete(child);
    });
    return child;
  }

  get running(): number {
    return this.children.size;
  }

  /** Once per window: a command started since the first call already waits at the gate. */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    for (const child of this.children) this.signal(child, 'SIGSTOP');
    this.emit('suspend');
  }

  resume(): void {
    this.suspended = false;
    for (const child of this.children) this.signal(child, 'SIGCONT');
    // After the signal: a child stopped at the gate has to be running to read it.
    for (const child of this.waiting) (child.stdio[3] as Writable | null)?.end();
    this.waiting.clear();
    this.emit('resume');
  }

  /**
   * Kill every group on the list when the runtime exits. Each child has a session of
   * its own, so it outlives the runtime otherwise, and one stopped by a takeover would
   * stay stopped for good. SIGKILL reaches a stopped process.
   */
  private hookExit(): void {
    if (this.exitHooked) return;
    this.exitHooked = true;
    process.once('exit', () => {
      for (const child of this.children) this.signal(child, 'SIGKILL');
    });
  }

  /**
   * Signal a child's whole group. A child stopped by a takeover holds a stopped group,
   * and signalling its leader alone leaves the forked commands stopped with the output
   * pipe open.
   */
  kill(child: ChildProcess, signal: NodeJS.Signals): void {
    this.signal(child, signal);
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (pid !== undefined) {
      try {
        // The group, so a wrapper shell's own children are signalled too.
        process.kill(-pid, signal);
        return;
      } catch {
        // No such group: the child alone, below.
      }
    }
    try {
      child.kill(signal);
    } catch (err) {
      logger.warn({ err, pid }, `[AgentProcesses] ${signal} failed`);
    }
  }
}

export const agentProcesses = new AgentProcesses();
