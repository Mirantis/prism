/**
 * A command inside the exec container.
 *
 * Each one is a `docker exec` whose client is an ordinary child of this
 * process, so the streams, the exit code and the launch-failure path are the
 * local implementation's — only the argv differs.
 *
 * Signalling is the part that is not free. Killing the `docker exec` client
 * leaves the process it started running inside the container, so the payload
 * records its own process group id into a bind-mounted file and `kill()` sends
 * the signal with a second `docker exec`. `setsid` is what makes that id a
 * *group*: the wrapper becomes a session leader, so `$$` is the group id and
 * one signal reaches every grandchild — the same guarantee `processGroup: true`
 * gives locally.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../../logger';
import type { ExecProcess, RunOptions } from '../execution-environment';
import { runLocalProgram } from '../local/local-process';
import { DOCKER } from './engine';

/**
 * `$1` is where to write the group id; everything after it is the program and
 * its arguments. Passing them positionally rather than interpolating means no
 * command text is ever quoted into a shell string.
 */
const RECORD_PGID = 'echo $$ > "$1"; shift; exec "$@"';

/** How long the signalling `docker exec` gets before it is abandoned. */
const KILL_TIMEOUT_MS = 10_000;

export interface DockerExecContext {
  container: string;
  /** Bind-mounted at the same path on both sides, so the host can read the file. */
  runDir: string;
}

export function runDockerShell(
  command: string,
  options: RunOptions,
  ctx: DockerExecContext,
): ExecProcess {
  // `bash -c <command>` is the payload, so a shell command behaves exactly as
  // it does locally, where `runShell` execs /bin/bash -c too.
  return exec(['bash', '-c', command], options, ctx);
}

export function runDockerProgram(
  command: string,
  args: readonly string[],
  options: RunOptions,
  ctx: DockerExecContext,
): ExecProcess {
  return exec([command, ...args], options, ctx);
}

function exec(payload: string[], options: RunOptions, ctx: DockerExecContext): ExecProcess {
  const pidFile = path.join(ctx.runDir, `${randomUUID()}.pid`);

  // `-e NAME` without a value tells the engine to take it from its own client's
  // environment, which is the child we spawn below — so a credential reaches
  // the container without appearing in an argv.
  const names = Object.keys(options.env).filter((name) => options.env[name] !== undefined);
  const envFlags = names.flatMap((name) => ['-e', name]);

  const argv = [
    'exec',
    ...(options.stdin === 'pipe' ? ['-i'] : []),
    '-w',
    options.cwd,
    ...envFlags,
    ctx.container,
    // `--wait` is load-bearing. Under `docker exec` the entered process is
    // already a process-group leader, so `setsid` forks instead of exec'ing —
    // without it the parent exits 0 the moment the child starts, the engine's
    // client returns, and the command's output is read as empty while the work
    // runs on detached. With it, setsid waits and reports the child's status.
    'setsid',
    '--wait',
    'bash',
    '-c',
    RECORD_PGID,
    // `$0` for the wrapper; only its name shows up in the container's ps.
    'prism-exec',
    pidFile,
    ...payload,
  ];

  // The engine's client always reads our stdin, so it is piped whatever the
  // caller asked for; `-i` above is what decides whether the container sees it.
  const client = runLocalProgram(DOCKER, argv, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: options.stdin,
  });

  const cleanUp = () => fs.promises.rm(pidFile, { force: true }).catch(() => {});
  void client.closed.then(cleanUp);

  return {
    get stdin() {
      return client.stdin;
    },
    get stdout() {
      return client.stdout;
    },
    get stderr() {
      return client.stderr;
    },
    get exitCode() {
      return client.exitCode;
    },
    get signal() {
      return client.signal;
    },
    ended: client.ended,
    closed: client.closed,
    kill: (signal) => killPayload(ctx.container, pidFile, signal, client),
  };
}

/**
 * Signal the command, by its process group inside the container when that
 * group is known and by the engine's client when it is not.
 *
 * The fallback is what makes the kill unconditional. A caller kills to *end*
 * the run — `captureShell` does it on its timeout and on a cancel, then waits
 * on the same process — so a signal that reaches nothing leaves that caller
 * waiting for a command it already gave up on. The group id is missing for
 * about as long as the engine takes to start the payload, and a cancel can
 * land inside that window.
 *
 * Killing the client does not reach into the container, so a payload that
 * starts after that is left running. It is a few hundred milliseconds of
 * exposure against a container the runtime removes on the way out, and the
 * payload's first write to a closed pipe usually ends it anyway — worth it to
 * make the kill an answer rather than a maybe.
 */
function killPayload(
  container: string,
  pidFile: string,
  signal: NodeJS.Signals,
  client: ExecProcess,
): boolean {
  const pgid = readGroupId(pidFile);
  if (pgid === null) return client.kill(signal);

  // Through a shell, using its builtin `kill`, and with the `SIG` prefix
  // stripped: that is the POSIX spelling every shell accepts, while the
  // separate `kill` binaries disagree — Debian's procps rejects
  // `kill -SIGKILL -<pgid>` outright and wants `-- ` before a negative pid.
  const name = signal.replace(/^SIG/, '');
  const signaller = runLocalProgram(
    DOCKER,
    ['exec', container, 'sh', '-c', `kill -${name} -${pgid}`],
    { cwd: process.cwd(), env: process.env, stdin: 'ignore' },
  );
  const abandon = setTimeout(() => signaller.kill('SIGKILL'), KILL_TIMEOUT_MS);
  abandon.unref();
  void signaller.ended.then((end) => {
    clearTimeout(abandon);
    // Exit 1 is the ordinary "no such process": the group ended between the
    // read and the signal. Anything else is worth a line.
    if (end.error) logger.warn({ err: end.error, container }, '[Docker] could not signal');
  });
  return true;
}

/**
 * The payload's process group id, or null while the wrapper has yet to record
 * one — which also covers a command that has ended and cleaned its file up.
 */
function readGroupId(pidFile: string): string | null {
  let recorded: string;
  try {
    recorded = fs.readFileSync(pidFile, 'utf8').trim();
  } catch {
    return null;
  }
  return /^\d+$/.test(recorded) ? recorded : null;
}
