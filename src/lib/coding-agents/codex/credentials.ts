import path from 'node:path';
import { resolveDataDir } from '../../data-dir';
import type { ExecutionEnvironment } from '../../execution-environments/execution-environment';
import { hasBedrockCredentials } from '../bedrock-credentials';
import { probeCli } from '../cli-probe';

/**
 * Kept out of a run on the subscription: the variables Codex 0.163 takes a
 * credential from, each of which outranks a saved login, and the deployment's
 * OpenAI-compatible gateway, which must not receive the login's token.
 */
const LEAVES_THE_SUBSCRIPTION = new Set(['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL']);

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

/** `env` without the variables that outrank the home's saved login or move its endpoint. */
export function subscriptionEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !LEAVES_THE_SUBSCRIPTION.has(key)));
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
  const run = await probeCli(environment, 'codex', LOGIN_STATUS_ARGS, {
    env: { ...subscriptionEnvironment(env), CODEX_HOME: codexHome },
    signal,
  });
  return codexLoginFromStatus(`${run.stdout}\n${run.stderr}`, run.exitCode);
}

export const LOGIN_STATUS_ARGS = ['login', 'status', '-c', 'cli_auth_credentials_store="file"'];

/** The saved login `codex login status` printed. Throws when it printed no status. */
export function codexLoginFromStatus(output: string, exitCode: number | null): SavedCodexLogin {
  // Codex 0.163 writes the status to stderr, and exits 1 when nobody is signed in.
  if (/^Logged in using ChatGPT$/m.test(output)) return 'chatgpt';
  if (/^Logged in using /m.test(output)) return 'other';
  if (/^Not logged in$/m.test(output)) return 'none';
  throw new Error(`codex login status exited with ${exitCode} and no status`);
}

/**
 * The config a Codex run on the subscription takes: OpenAI's own provider at
 * ChatGPT's own endpoints, so the home's `config.toml` can't move it to one
 * that bills the deployment or receives the login's token, and the ChatGPT
 * login saved in the home's file store, and no other. Codex takes an empty
 * `openai_base_url` as unset, which for a ChatGPT login is ChatGPT's endpoint.
 */
export const SUBSCRIPTION_CONFIG_ARGS = [
  '-c', 'model_provider="openai"',
  '-c', 'openai_base_url=""',
  '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"',
  '-c', 'forced_login_method="chatgpt"',
  '-c', 'cli_auth_credentials_store="file"',
];
