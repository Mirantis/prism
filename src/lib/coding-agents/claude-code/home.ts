import path from 'node:path';
import { resolveDataDir } from '../../data-dir';

/**
 * Where the Claude Code CLI keeps its own state — sessions, `.claude.json`,
 * and the skills symlink. An operator's `CLAUDE_CONFIG_DIR` wins; otherwise it
 * sits inside the runtime's data dir, so the user's real `~/.claude` is never
 * touched.
 *
 * Resolved from the env the CLI will run with rather than read off this
 * process, because the CLI runs in the execution environment and inherits that
 * environment's own variables.
 */
export function resolveClaudeConfigDir(
  env: NodeJS.ProcessEnv,
  dataDir = resolveDataDir(),
): string {
  return path.resolve(env.CLAUDE_CONFIG_DIR || path.join(dataDir, '.claude'));
}
