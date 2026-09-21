/**
 * A command inside the exec container.
 *
 * Each one is a `docker exec` whose client is an ordinary child of this
 * process, so the streams, the exit code and the launch-failure path are the
 * local implementation's — only the argv differs.
 *
 * Signalling is the part that is not free. Killing the `docker exec` client
 * leaves the process it started running inside the container, so the signal
 * is delivered by a second `docker exec`, which has to find the right process
 * once it is in there. The wrapper records its own id into a file in the
 * container before it starts the command, and the kill reads that file on the
 * same side. `setsid` is what makes one signal reach every grandchild: the
 * wrapper becomes a session leader, so `$$` is the process-group id — the
 * guarantee `processGroup: true` gives locally.
 *
 * The id has to be written down rather than looked up, because `exec`
 * replaces the command line: a name given to the wrapper is gone the moment
 * the command starts, while the pid it already wrote is still the group's.
 */
import { randomUUID } from 'crypto';
import { logger } from '../../../logger';
import type { ExecProcess, RunOptions } from '../execution-environment';
import { runLocalProgram } from '../local/local-process';
import { DOCKER } from './engine';

/** How long the signalling `docker exec` gets before it is abandoned. */
const KILL_TIMEOUT_MS = 10_000;

/**
 * `$1` is where to write the group id; everything after it is the program and
 * its arguments. Passing them positionally rather than interpolating means no
 * command text is ever quoted into a shell string.
 */
const RECORD_PGID = 'echo $$ > "$1"; shift; exec "$@"';

/**
 * Read the group id the wrapper recorded and signal the whole group.
 *
 * `$1` is the file, `$2` the signal name. The leader's pid is the group id, so
 * the negative pid reaches every descendant. Exit 1 when the file holds
 * nothing, which is a command that has already ended or has yet to start.
 */
const SIGNAL_GROUP =
  'p=$(cat "$1" 2>/dev/null); [ -n "$p" ] || exit 1; kill -"$2" -"$p"';

/**
 * Where a command records its group id, inside the container.
 *
 * Nothing outside reads it, so it needs no volume — and nothing removes it
 * either: the file is a handful of bytes and the container is rebuilt on every
 * restart, which is cheaper than a second `docker exec` per command to tidy up.
 */
function pidFileFor(id: string): string {
  return `/tmp/prism-exec-${id}.pid`;
}

export interface DockerExecContext {
  container: string;
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
  const pidFile = pidFileFor(randomUUID());

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

  // The engine's client is a host process, so it is started in a host
  // directory — `-w` above is what puts the command in the caller's cwd, which
  // is a path inside the container and exists nowhere out here.
  //
  // The engine's client always reads our stdin, so it is piped whatever the
  // caller asked for; `-i` above is what decides whether the container sees it.
  const client = runLocalProgram(DOCKER, argv, {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
    stdin: options.stdin,
  });

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
 * Signal the command's process group inside the container.
 *
 * A terminating signal has to end something the caller is waiting on, and the
 * group kill alone cannot promise that: between the engine starting and the
 * wrapper running, the file holds nothing. `SIGKILL` therefore also kills
 * the engine's client, which settles `ended` and `closed` whatever happened
 * inside. It is left out of the gentler signals so a command still gets to
 * flush its output on `SIGTERM`, and `captureShell` escalates to `SIGKILL`
 * after its grace period, so the guarantee holds with that delay at worst.
 */
function killPayload(
  container: string,
  pidFile: string,
  signal: NodeJS.Signals,
  client: ExecProcess,
): boolean {
  // POSIX spelling, which every shell's builtin `kill` accepts, while the
  // separate binaries disagree — Debian's procps rejects `kill -SIGKILL` and
  // wants `--` before a negative pid.
  const name = signal.replace(/^SIG/, '');
  const signaller = runLocalProgram(
    DOCKER,
    ['exec', container, 'sh', '-c', SIGNAL_GROUP, 'prism-kill', pidFile, name],
    { cwd: process.cwd(), env: process.env, stdin: 'ignore' },
  );
  const abandon = setTimeout(() => signaller.kill('SIGKILL'), KILL_TIMEOUT_MS);
  abandon.unref();
  void signaller.ended.then((end) => {
    clearTimeout(abandon);
    // Exit 1 is the ordinary "nothing to signal": the command ended between
    // the decision and the signal. Anything else is worth a line.
    if (end.error) logger.warn({ err: end.error, container }, '[Docker] could not signal');
  });

  if (signal === 'SIGKILL') return client.kill(signal);
  return true;
}
