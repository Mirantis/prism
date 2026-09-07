/**
 * `shell_spawn` family — generic background-process control for the
 * agent. Distinct from `coding_agent` (which is its own dedicated tool
 * over a fixed CLI surface): this set lets the agent start arbitrary
 * long-running shell tasks (e.g. `npm run test`), feed them stdin,
 * drain accumulated stdout/stderr, and kill them — all without
 * blocking other tool calls.
 *
 * Port of the upstream Lens Agents shell sandbox's process handlers,
 * with the per-process state map living in `process-manager.ts`.
 */
import { z } from 'zod';
import { resolvePath } from './workspace';
import { getProcessManager } from './process-manager';

export const shellSpawnInput = z.object({
  command: z.string().describe('The shell command to start as a background process'),
  workdir: z
    .string()
    .optional()
    .describe(
      'Working directory (default: workspace root). Relative paths resolve from the workspace root; absolute paths are used as-is.',
    ),
});

export const shellStdinInput = z.object({
  processId: z.string().describe('Process ID returned by shell_spawn'),
  data: z.string().describe('Data to write to the process\'s stdin (raw, no automatic newline)'),
});

export const shellStdoutInput = z.object({
  processId: z.string().describe('Process ID returned by shell_spawn'),
  drainStderr: z
    .boolean()
    .optional()
    .describe('If true, drain stderr instead of stdout (default: false). Call once per stream.'),
});

export const shellKillInput = z.object({
  processId: z.string().describe('Process ID returned by shell_spawn'),
  signal: z
    .enum(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'])
    .optional()
    .describe('Signal to send (default: SIGTERM).'),
});

export async function runShellSpawn(
  input: z.infer<typeof shellSpawnInput>,
  workspace: string,
): Promise<{ processId: string }> {
  const cwd = input.workdir ? resolvePath(workspace, input.workdir) : workspace;
  const processId = getProcessManager().spawn({ command: input.command, workdir: cwd });
  return { processId };
}

export async function runShellStdin(
  input: z.infer<typeof shellStdinInput>,
): Promise<{ ok: true } | { error: string }> {
  try {
    getProcessManager().stdin(input.processId, input.data);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runShellStdout(
  input: z.infer<typeof shellStdoutInput>,
): Promise<
  | {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      running: boolean;
      truncated: { stdout: boolean; stderr: boolean };
    }
  | { error: string }
> {
  try {
    return getProcessManager().drain(input.processId, input.drainStderr ?? false);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runShellKill(
  input: z.infer<typeof shellKillInput>,
): Promise<{ ok: boolean }> {
  // Don't reap on kill — the signal is async and the process may
  // ignore SIGTERM. The map entry is kept so:
  //   - runningCount() still sees it (MAX_PROCESSES isn't bypassed),
  //   - the agent can still drain final output,
  //   - the agent can re-call shell_kill with SIGKILL if needed.
  // The natural lifecycle (close handler in process-manager.ts sets
  // exitCode) takes the process out of the running count once it
  // actually exits; the entry is purged on the next drain after exit.
  const ok = getProcessManager().kill(input.processId, input.signal);
  return { ok };
}
