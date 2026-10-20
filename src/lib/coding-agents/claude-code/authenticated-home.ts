import { captureProgram } from '../../execution-environments/capture';
import type { ExecutionEnvironment } from '../../execution-environments/execution-environment';

/** How long the CLI gets to answer before the probe gives up on it. */
const PROBE_TIMEOUT_MS = 10_000;

/** Enough for the status JSON and whatever else the CLI prints around it. */
const PROBE_OUTPUT_LIMIT = 64 * 1024;

/**
 * The variables that outrank a saved login in the CLI's credential order, or
 * send its requests somewhere other than the account's own API.
 */
const OUTRANKS_SAVED_LOGIN = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$)/;

/**
 * The login saved in the CLI's home: a Claude subscription signed in through
 * claude.ai, another saved login, or none.
 */
export type SavedLogin = 'subscription' | 'other' | 'none';

/** The fields of `claude auth status --json` this reads; the rest name the account. */
interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  subscriptionType?: string | null;
}

/** `env` without the variables that outrank the home's saved login. */
export function subscriptionEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !OUTRANKS_SAVED_LOGIN.test(key)));
}

/**
 * Ask `claude auth status` about the home's saved login, in the environment
 * where the binary and its home are. It runs with `subscriptionEnvironment`, so
 * the answer is about the home alone.
 *
 * Throws when the CLI gives no answer. Only the parsed fields are read: the
 * CLI's output names the account, so none of it reaches a message.
 */
export async function readSavedLogin(
  environment: ExecutionEnvironment,
  env: NodeJS.ProcessEnv,
  configDir: string,
  signal?: AbortSignal,
): Promise<SavedLogin> {
  try {
    await environment.files.stat(configDir);
  } catch {
    return 'none';
  }
  const run = await captureProgram(environment, 'claude', ['auth', 'status', '--json'], {
    cwd: environment.workspaceRoot(),
    env: { ...subscriptionEnvironment(env), CLAUDE_CONFIG_DIR: configDir },
    timeoutMs: PROBE_TIMEOUT_MS,
    limitBytes: PROBE_OUTPUT_LIMIT,
    abortSignal: signal,
  });
  if (run.error) throw new Error(`claude auth status failed: ${run.error.message}`);
  if (run.timedOut) throw new Error(`claude auth status did not answer in ${PROBE_TIMEOUT_MS / 1000} s`);
  // The CLI exits 1 with the same JSON when nobody is signed in.
  let status: AuthStatus;
  try {
    status = JSON.parse(run.stdout) as AuthStatus;
  } catch {
    throw new Error(`claude auth status exited with ${run.exitCode} and no status`);
  }
  if (status.loggedIn !== true) return 'none';
  return status.authMethod === 'claude.ai' && status.subscriptionType ? 'subscription' : 'other';
}
