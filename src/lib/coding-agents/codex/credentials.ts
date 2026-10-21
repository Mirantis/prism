import path from 'node:path';
import { resolveDataDir } from '../../data-dir';
import type { ExecutionEnvironment } from '../../execution-environments/execution-environment';
import { hasBedrockCredentials } from '../bedrock-credentials';
import { probeCli } from '../cli-probe';

/** The variables Codex 0.163 takes a credential from, each of which outranks a saved login. */
const OUTRANKS_SAVED_LOGIN = new Set(['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN']);

/** How a Codex task authenticates. */
export type CodexAuthMethod = 'api' | 'saved' | 'bedrock' | 'subscription';

/** The login saved in the CLI's home: a ChatGPT sign-in, another saved login, or none. */
export type SavedCodexLogin = 'chatgpt' | 'other' | 'none';

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
): Exclude<CodexAuthMethod, 'subscription'> | undefined {
  if (codexApiKey(env)) return 'api';
  // Codex validates the saved credentials and refreshes its own login tokens.
  if (savedLogin) return 'saved';
  if (hasBedrockCredentials(env)) return 'bedrock';
  return undefined;
}

/** `env` without the variables that outrank the home's saved login. */
export function subscriptionEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !OUTRANKS_SAVED_LOGIN.has(key)));
}

/**
 * Ask `codex login status` about the home's saved login, in the environment
 * where the binary and its home are, from the same credential store a task
 * reads.
 *
 * Throws when the CLI gives no answer. Only the status line's form is read:
 * for an API key the line shows part of the key, so none of it reaches a
 * message.
 */
export async function readCodexLogin(
  environment: ExecutionEnvironment,
  env: NodeJS.ProcessEnv,
  codexHome: string,
  signal?: AbortSignal,
): Promise<SavedCodexLogin> {
  const run = await probeCli(environment, 'codex', ['login', 'status', '-c', 'cli_auth_credentials_store="file"'], {
    env: { ...subscriptionEnvironment(env), CODEX_HOME: codexHome },
    signal,
  });
  // Codex 0.163 writes the status to stderr, and exits 1 when nobody is signed in.
  const status = `${run.stdout}\n${run.stderr}`;
  if (/^Logged in using ChatGPT$/m.test(status)) return 'chatgpt';
  if (/^Logged in using /m.test(status)) return 'other';
  if (/^Not logged in$/m.test(status)) return 'none';
  throw new Error(`codex login status exited with ${run.exitCode} and no status`);
}
