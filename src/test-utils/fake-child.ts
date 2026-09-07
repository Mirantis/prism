/**
 * Fake child processes for tests that drive `runCli` without launching a real
 * coding-agent binary. Each stands in for a `ChildProcess` at the seam the run
 * helper reads: stdout/stderr streams, exit and signal codes, `kill`, and the
 * `exit` / `error` events.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';

export class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  // Real ChildProcess exposes this, and the SIGKILL escalation reads it to
  // decide whether the child is still alive. Diverging here would make an
  // escalation test silently pass without ever escalating.
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  signals: string[] = [];
  kill(signal?: string): boolean {
    this.killed = true;
    this.signals.push(signal ?? 'SIGTERM');
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
  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

/**
 * A child that ignores every signal and never closes stdout — an agent that
 * hangs, or one whose grandchild inherited the pipe. The run's stream can
 * never end for this one, so the caller has to give up on its own.
 */
export class StubbornChild extends FakeChild {
  override kill(signal?: string): boolean {
    this.killed = true;
    this.signals.push(signal ?? 'SIGTERM');
    return true;
  }
}

/** A child that honours SIGKILL only, so the escalation after SIGTERM is observable. */
export class SigkillOnlyChild extends FakeChild {
  override kill(signal?: string): boolean {
    this.killed = true;
    this.signals.push(signal ?? 'SIGTERM');
    if (signal === 'SIGKILL') {
      this.signalCode = 'SIGKILL';
      this.finish(null);
    }
    return true;
  }
}

/** A child whose spawn fails, as `spawn` reports it: one 'error', never 'exit'. */
export class FailedSpawnChild extends FakeChild {
  fail(message: string): void {
    // Mirrors Node: the streams are torn down and 'error' fires on its own turn.
    this.stdout.end();
    this.stderr.end();
    process.nextTick(() => this.emit('error', new Error(message)));
  }
}
