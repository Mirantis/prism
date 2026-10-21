/**
 * One short command of a coding agent's CLI, run for its answer: a login
 * status, read before a task starts.
 */

import { captureProgram, type CaptureResult } from '../execution-environments/capture';
import type { ExecutionEnvironment } from '../execution-environments/execution-environment';

/** How long the CLI gets to answer before the probe gives up on it. */
const PROBE_TIMEOUT_MS = 10_000;

/** Enough for a status and whatever else the CLI prints around it. */
const PROBE_OUTPUT_LIMIT = 64 * 1024;

/**
 * Run `command` in the environment where the binary and its home are, and
 * return what it printed for the caller to read. Throws when it does not start
 * or does not answer in time, naming it by its command and subcommand words.
 */
export async function probeCli(
  environment: ExecutionEnvironment,
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<CaptureResult> {
  const firstFlag = args.findIndex((arg) => arg.startsWith('-'));
  const name = [command, ...(firstFlag === -1 ? args : args.slice(0, firstFlag))].join(' ');
  const run = await captureProgram(environment, command, args, {
    cwd: environment.workspaceRoot(),
    env: options.env,
    timeoutMs: PROBE_TIMEOUT_MS,
    limitBytes: PROBE_OUTPUT_LIMIT,
    abortSignal: options.signal,
  });
  if (run.error) throw new Error(`${name} failed: ${run.error.message}`);
  if (run.timedOut) throw new Error(`${name} did not answer in ${PROBE_TIMEOUT_MS / 1000} s`);
  return run;
}
