/**
 * Processes for the local environment: a child of this server process.
 *
 * `ended` and `closed` are separate because the two callers need different
 * moments. Exit accounting reads `ended`, since a grandchild that inherited
 * the pipes can hold them open long after the process is gone; a caller that
 * builds a result out of the output reads `closed`.
 */
import { ChildProcess, spawn } from 'child_process';
import type { ExecEnd, ExecProcess, RunOptions } from '../execution-environment';

const SHELL = '/bin/bash';

/**
 * `processGroup` makes the child lead its own group, so `kill` signals the whole
 * group rather than leaving a shell wrapper's forked children behind. Every
 * command the agent starts runs that way; the runtime's own calls, such as the
 * container engine's client, stay in the runtime's group.
 */
export function runLocalShell(
  command: string,
  options: RunOptions,
  processGroup = false,
): ExecProcess {
  return wrap(spawnLocal(SHELL, ['-c', command], options, processGroup), processGroup);
}

export function runLocalProgram(
  command: string,
  args: readonly string[],
  options: RunOptions,
  processGroup = false,
): ExecProcess {
  return wrap(spawnLocal(command, args, options, processGroup), processGroup);
}

function spawnLocal(
  command: string,
  args: readonly string[],
  options: RunOptions,
  processGroup: boolean,
): ChildProcess {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: [options.stdin, 'pipe', 'pipe'],
    detached: processGroup,
  });
}

function wrap(child: ChildProcess, processGroup: boolean): ExecProcess {
  // A spawn failure — a missing binary, a cwd that doesn't exist — emits
  // 'error' and nothing else. Unhandled, that event takes the runtime down, so
  // claim it here and report it as the end of the process.
  let launchError: Error | null = null;
  child.on('error', (err: Error) => {
    launchError = err;
  });

  const end = (): ExecEnd => ({
    exitCode: typeof child.exitCode === 'number' ? child.exitCode : null,
    signal: child.signalCode,
    error: launchError,
  });

  const settle = (event: 'exit' | 'close'): Promise<ExecEnd> =>
    new Promise<ExecEnd>((resolve) => {
      child.once(event, () => resolve(end()));
      child.once('error', (err: Error) => resolve({ exitCode: null, signal: null, error: err }));
    });

  const ended = settle('exit');
  const closed = settle('close');
  const mark = processGroup && child.pid !== undefined ? { pid: child.pid, startedAt: Date.now() } : undefined;

  return {
    mark,
    get stdin() {
      return child.stdin;
    },
    get stdout() {
      return child.stdout;
    },
    get stderr() {
      return child.stderr;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signal() {
      return child.signalCode;
    },
    ended,
    closed,
    kill: (signal) => killChild(child, signal, processGroup),
  };
}

function killChild(child: ChildProcess, signal: NodeJS.Signals, processGroup: boolean): boolean {
  const pid = child.pid;
  if (processGroup && pid !== undefined) {
    // The group first, so any grandchild of the shell wrapper gets the signal
    // too. Falls back to the child alone where a detached spawn established no
    // new process group.
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Fall through to the direct kill below.
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}
