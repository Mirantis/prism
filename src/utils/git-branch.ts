/**
 * Resolve the current git branch of a directory.
 *
 * Used by the single-agent threads list to label each resumable conversation
 * with the branch its workspace root is on. Returns null when the directory
 * isn't a git work tree, is in detached-HEAD state, or git isn't available —
 * callers fall back to showing just the path.
 *
 * Asked of the execution environment: the directory is a thread's workspace
 * root, which is where the agent's own commands run.
 */

import { captureProgram } from '../lib/execution-environments/capture';
import { getExecutionEnvironment } from '../lib/execution-environments/get-execution-environment';

const TIMEOUT_MS = 2_000;
/** A branch name; anything longer is not one. */
const OUTPUT_LIMIT = 4 * 1024;

export async function getGitBranch(dir: string): Promise<string | null> {
  if (!dir) return null;
  const environment = getExecutionEnvironment();
  const run = await captureProgram(environment, 'git', ['branch', '--show-current'], {
    cwd: dir,
    env: environment.baseEnv(),
    timeoutMs: TIMEOUT_MS,
    limitBytes: OUTPUT_LIMIT,
  });
  // Not a git repo, detached HEAD (empty output), git missing, or a directory
  // that isn't there — no branch to show.
  if (run.error || run.exitCode !== 0) return null;
  const branch = run.stdout.trim();
  return branch.length > 0 ? branch : null;
}
