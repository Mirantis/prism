import path from 'node:path';
import { resolveDataDir } from '../../data-dir';
import type { ExecutionEnvironment } from '../../execution-environments/execution-environment';
import { hasBedrockCredentials } from '../bedrock-credentials';

export function resolveCodexHome(env: NodeJS.ProcessEnv, dataDir = resolveDataDir()): string {
  return path.resolve(env.CODEX_HOME || path.join(dataDir, '.codex'));
}

/**
 * Whether the CLI has a saved login in its home.
 *
 * Asked of the execution environment, because that is where the home is.
 * Never throws: no answer means no saved login.
 */
export async function hasSavedCodexLogin(environment: ExecutionEnvironment): Promise<boolean> {
  try {
    await environment.files.stat(`${environment.paths().codexHome}/auth.json`);
    return true;
  } catch {
    return false;
  }
}

export function codexApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.CODEX_API_KEY || env.OPENAI_API_KEY;
}

/**
 * `savedLogin` is the boot-time answer from `hasSavedCodexLogin`: reading the
 * home costs a round trip to the execution environment, and this is asked
 * while building a task's argv, where there is nothing to await on.
 */
export function codexAuthMethod(
  env: NodeJS.ProcessEnv,
  savedLogin = false,
): 'api' | 'saved' | 'bedrock' | undefined {
  if (codexApiKey(env)) return 'api';
  // Codex validates the saved credentials and refreshes its own login tokens.
  if (savedLogin) return 'saved';
  if (hasBedrockCredentials(env)) return 'bedrock';
  return undefined;
}
