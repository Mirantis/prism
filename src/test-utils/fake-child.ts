/**
 * Fake processes for tests that drive `runCli` without launching a real
 * coding-agent binary. Each stands in for an `ExecProcess` at the seam the run
 * helper reads: stdin/stdout/stderr, exit and signal codes, `kill`, and the
 * `ended` / `closed` outcomes.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ExecEnd, ExecProcess } from '../lib/execution-environments/execution-environment';

export class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  // A real process exposes this, and the SIGKILL escalation reads it to
  // decide whether the process is still alive. Diverging here would make an
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
    process.nextTick(() => {
      this.emit('exit', code, null);
      this.emit('close', code, null);
    });
  }

  asExecProcess(): ExecProcess {
    const end = (): ExecEnd => ({
      exitCode: this.exitCode,
      signal: this.signalCode,
      error: null,
    });
    const settle = (event: 'exit' | 'close'): Promise<ExecEnd> =>
      new Promise<ExecEnd>((resolve) => {
        this.once(event, () => resolve(end()));
        this.once('error', (err: Error) => resolve({ exitCode: null, signal: null, error: err }));
      });
    const ended = settle('exit');
    const closed = settle('close');
    // Read through arrows so the getters below see the live process, which a
    // captured value would not.
    const exitCode = () => this.exitCode;
    const signal = () => this.signalCode;
    return {
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      get exitCode() {
        return exitCode();
      },
      get signal() {
        return signal();
      },
      ended,
      closed,
      kill: (sig) => this.kill(sig),
    };
  }
}

/**
 * A process that ignores every signal and never closes stdout — an agent that
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

/** A process that honours SIGKILL only, so the escalation after SIGTERM is observable. */
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

/** A process whose launch fails, as the environment reports it: 'error', never 'exit'. */
export class FailedSpawnChild extends FakeChild {
  fail(message: string): void {
    // Mirrors Node: the streams are torn down and 'error' fires on its own turn.
    this.stdout.end();
    this.stderr.end();
    process.nextTick(() => this.emit('error', new Error(message)));
  }
}
