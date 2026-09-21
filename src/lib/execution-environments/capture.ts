/**
 * Run one command in the execution environment and collect what it printed.
 *
 * The one place a bounded, timed, cancellable run is written: `shell_exec`
 * formats its own result out of this, and so does every probe that shells out
 * for a single answer. A process that outlives its call belongs to
 * `tools/shell/process-manager.ts` instead, which streams rather than collects.
 */

import type { ExecEnd, ExecProcess, ExecutionEnvironment } from './execution-environment';

export interface CaptureOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Bytes kept per stream; the rest is dropped and reported as truncated. */
  limitBytes: number;
  /** Kills the process when the turn is canceled mid-command. */
  abortSignal?: AbortSignal;
}

export interface CaptureResult {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** The command ran past `timeoutMs` and was killed. */
  timedOut: boolean;
  /** The caller's signal fired and the command was killed. */
  aborted: boolean;
  /** Set when the command never started. */
  error: Error | null;
}

/** How long a killed process gets to honour SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;

export function captureShell(
  environment: ExecutionEnvironment,
  command: string,
  options: CaptureOptions,
): Promise<CaptureResult> {
  return collect(
    environment.runShell(command, { cwd: options.cwd, env: options.env, stdin: 'ignore' }),
    options,
  );
}

export function captureProgram(
  environment: ExecutionEnvironment,
  command: string,
  args: readonly string[],
  options: CaptureOptions,
): Promise<CaptureResult> {
  return collect(
    environment.runProgram(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdin: 'ignore',
    }),
    options,
  );
}

async function collect(proc: ExecProcess, options: CaptureOptions): Promise<CaptureResult> {
  const out = stream(proc.stdout, options.limitBytes);
  const err = stream(proc.stderr, options.limitBytes);

  // SIGTERM, then escalate to SIGKILL if the process hasn't exited shortly
  // after. Shared by the timeout and the cancel paths.
  const terminate = () => {
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }, KILL_GRACE_MS).unref();
  };

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);
  timer.unref();

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    terminate();
  };
  const signal = options.abortSignal;
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  // `closed` rather than `ended`: the result is the output, so it waits for the
  // pipes to drain as well.
  let end: ExecEnd;
  try {
    end = await proc.closed;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  return {
    stdout: out.text(),
    stderr: err.text(),
    stdoutTruncated: out.truncated(),
    stderrTruncated: err.truncated(),
    exitCode: end.exitCode,
    signal: end.signal,
    timedOut,
    aborted,
    error: end.error,
  };
}

/** A capped reader over one output stream. */
function stream(readable: ExecProcess['stdout'], limitBytes: number) {
  const chunks: Buffer[] = [];
  const count = { n: 0 };
  const trunc = { t: false };
  readable?.on('data', (chunk: Buffer) =>
    appendCappedChunk(chunk, chunks, count, trunc, limitBytes),
  );
  return {
    text: () => Buffer.concat(chunks, count.n).toString('utf8'),
    truncated: () => trunc.t,
  };
}

/**
 * Append a chunk to a capped buffer list. Tracks the running byte
 * count so a later `Buffer.concat(chunks, countRef.n)` produces the
 * correct length (without this, the partial chunk at the cap
 * boundary would be silently dropped).
 */
export function appendCappedChunk(
  chunk: Buffer,
  chunks: Buffer[],
  countRef: { n: number },
  truncRef: { t: boolean },
  cap: number,
): void {
  if (truncRef.t) return;
  const remaining = cap - countRef.n;
  if (chunk.length <= remaining) {
    chunks.push(chunk);
    countRef.n += chunk.length;
  } else {
    if (remaining > 0) {
      chunks.push(chunk.subarray(0, remaining));
      countRef.n += remaining;
    }
    truncRef.t = true;
  }
}
