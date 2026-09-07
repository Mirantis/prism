import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../../data-dir';

/** Let the CLI check its saved login, including platform credential stores. */
export function hasAuthenticatedClaudeHome(env: NodeJS.ProcessEnv): boolean {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(resolveDataDir(), '.claude');
  if (!fs.existsSync(configDir)) return false;
  try {
    const output = execFileSync('claude', ['auth', 'status', '--json'], {
      env: { ...env, CLAUDE_CONFIG_DIR: configDir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return JSON.parse(output).loggedIn === true;
  } catch {
    return false;
  }
}
