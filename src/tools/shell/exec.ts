/**
 * `shell_exec` tool — in-process port of
 * `nexus-monorepo/packages/nexus/src/mcp/handlers/shell.handlers.ts :: shell_exec`.
 *
 * Runs a single shell command in a bash subprocess with a timeout.
 * Captures stdout + stderr (up to MAX_EXEC_OUTPUT_BYTES each) and
 * returns them alongside the exit code. Input schema + return shape
 * are identical to upstream so the agent's tool contract doesn't
 * change between modes.
 */
import { spawn } from 'child_process';
import { z } from 'zod';
import { sandboxEnv } from './sandbox-env';
import { resolvePath } from './workspace';
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  MAX_EXEC_OUTPUT_BYTES,
  MAX_EXEC_OUTPUT_LIMIT,
  DEFAULT_EXEC_OUTPUT_LIMIT_BYTES,
} from './config';

const shellExecInput = z.object({
  command: z.string().describe('The shell command to execute'),
  workdir: z
    .string()
    .optional()
    .describe(
      'Working directory (default: workspace root). Relative paths resolve from the workspace root; absolute paths are used as-is.',
    ),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_EXEC_TIMEOUT_MS)
    .optional()
    .describe('Timeout in milliseconds (default: 30000). Max 20 minutes.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_EXEC_OUTPUT_BYTES)
    .optional()
    .describe(
      `Maximum number of bytes to capture per stream (default: ${DEFAULT_EXEC_OUTPUT_LIMIT_BYTES}, max: ${MAX_EXEC_OUTPUT_LIMIT}).`,
    ),
});

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  /** Set when the run was killed because the turn was canceled mid-command. */
  aborted?: boolean;
}

/**
 * Append a chunk to a capped buffer list. Tracks the running byte
 * count so a later `Buffer.concat(chunks, countRef.n)` produces the
 * correct length (without this, the partial chunk at the cap
 * boundary would be silently dropped).
 *
 * Exported for unit tests.
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

/**
 * Core exec path — exposed separately for testing without wiring
 * through the AI SDK tool surface.
 */
export async function runShellExec(
  input: z.infer<typeof shellExecInput>,
  workspace: string,
  abortSignal?: AbortSignal,
): Promise<ExecResult> {
  const cwd = input.workdir ? resolvePath(workspace, input.workdir) : workspace;
  const timeoutMs = Math.min(input.timeout ?? DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS);
  const outputLimit = Math.min(
    input.limit ?? DEFAULT_EXEC_OUTPUT_LIMIT_BYTES,
    MAX_EXEC_OUTPUT_BYTES,
  );

  return new Promise<ExecResult>((resolve) => {
    const child = spawn('/bin/bash', ['-c', input.command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sandboxEnv(),
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const collect = (
      chunk: Buffer,
      chunks: Buffer[],
      countRef: { n: number },
      truncRef: { t: boolean },
    ) => appendCappedChunk(chunk, chunks, countRef, truncRef, outputLimit);

    const outState = { n: stdoutBytes };
    const outTrunc = { t: stdoutTruncated };
    const errState = { n: stderrBytes };
    const errTrunc = { t: stderrTruncated };

    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, stdoutChunks, outState, outTrunc));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, stderrChunks, errState, errTrunc));

    // SIGTERM, then escalate to SIGKILL if the child hasn't exited shortly
    // after. Shared by the timeout and the cancel (abort) paths.
    const terminate = () => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2000).unref();
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref();

    // Cancel propagation: when the turn is aborted mid-command, kill the child
    // so it doesn't run on to its own timeout in the background. The signal is
    // the per-turn AbortSignal threaded from generateText's tool execution.
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    const done = (exitCode: number) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      stdoutBytes = outState.n;
      stderrBytes = errState.n;
      stdoutTruncated = outTrunc.t;
      stderrTruncated = errTrunc.t;
      let stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
      let stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
      const marker = `\n... (truncated; exceeded ${outputLimit} bytes)`;
      if (stdoutTruncated) stdout += marker;
      if (stderrTruncated) stderr += marker;
      const result: ExecResult = { stdout, stderr, exitCode };
      if (timedOut) result.timedOut = true;
      if (aborted) result.aborted = true;
      resolve(result);
    };

    child.on('error', (err) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: -1,
      });
    });
    child.on('close', (code, signal) => {
      done(typeof code === 'number' ? code : signal ? 128 + signalNumber(signal) : -1);
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  const table: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return table[signal] ?? 0;
}

export { shellExecInput };
