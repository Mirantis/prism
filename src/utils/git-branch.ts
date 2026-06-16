/**
 * Resolve the current git branch of a directory.
 *
 * Used by the single-agent threads list to label each resumable conversation
 * with the branch its workspace root is on. Returns null when the directory
 * isn't a git work tree, is in detached-HEAD state, or git isn't available —
 * callers fall back to showing just the path.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function getGitBranch(dir: string): Promise<string | null> {
  if (!dir) return null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'branch', '--show-current'], {
      timeout: 2000,
      windowsHide: true,
    });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    // Not a git repo, detached HEAD (empty output is handled above), or git
    // missing — no branch to show.
    return null;
  }
}
