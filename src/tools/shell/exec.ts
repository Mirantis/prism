/**
 * `shell_exec` tool — in-process port of the upstream Lens Agents shell
 * sandbox's `shell_exec` handler.
 *
 * Runs a single shell command in the execution environment with a timeout.
 * Captures stdout + stderr (up to MAX_EXEC_OUTPUT_BYTES each) and
 * returns them alongside the exit code. Input schema + return shape
 * are identical to upstream so the agent's tool contract doesn't
 * change between modes.
 */
import { z } from 'zod';
import { captureShell } from '../../lib/execution-environments/capture';
import { getExecutionEnvironmentFor } from '../../lib/execution-environments/get-execution-environment';
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
 * Core exec path — exposed separately for testing without wiring
 * through the AI SDK tool surface.
 */
export async function runShellExec(
  input: z.infer<typeof shellExecInput>,
  workspace: string,
  abortSignal?: AbortSignal,
): Promise<ExecResult> {
  const cwd = input.workdir ? resolvePath(workspace, input.workdir) : workspace;
  // Per path: a thread rooted in a repository the container cannot see runs on
  // the host instead.
  const environment = getExecutionEnvironmentFor(cwd);
  const outputLimit = Math.min(
    input.limit ?? DEFAULT_EXEC_OUTPUT_LIMIT_BYTES,
    MAX_EXEC_OUTPUT_BYTES,
  );

  const run = await captureShell(environment, input.command, {
    cwd,
    env: environment.baseEnv(),
    timeoutMs: Math.min(input.timeout ?? DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS),
    limitBytes: outputLimit,
    abortSignal,
  });

  if (run.error) {
    return { stdout: '', stderr: run.error.message, exitCode: -1 };
  }

  const marker = `\n... (truncated; exceeded ${outputLimit} bytes)`;
  const result: ExecResult = {
    stdout: run.stdoutTruncated ? run.stdout + marker : run.stdout,
    stderr: run.stderrTruncated ? run.stderr + marker : run.stderr,
    exitCode: exitCodeOf(run.exitCode, run.signal),
  };
  if (run.timedOut) result.timedOut = true;
  if (run.aborted) result.aborted = true;
  return result;
}

function exitCodeOf(exitCode: number | null, signal: NodeJS.Signals | null): number {
  if (typeof exitCode === 'number') return exitCode;
  return signal ? 128 + signalNumber(signal) : -1;
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
