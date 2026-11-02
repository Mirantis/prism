import type { ExecutionEnvironment } from '../../execution-environments/execution-environment';
import { probeCli } from '../cli-probe';

/**
 * The variables that outrank a saved login in the CLI's credential order, or
 * send its requests somewhere other than the account's own API.
 */
const OUTRANKS_SAVED_LOGIN = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$)/;

/**
 * The provider switches and credentials among those variables that Claude Code
 * 2.1.304 reads. `subscriptionEnvironment` takes them out of the task's env,
 * but the `env` block of a repository's `.claude/settings.json` or
 * `settings.local.json` sets them again, and `forceLoginMethod` does not refuse
 * a provider or key chosen there. Flag settings outrank both files, so a task's
 * `--settings` restates each one empty. A provider's own base URL needs no
 * entry: nothing reads it while its switch is off.
 */
export const SAVED_LOGIN_OVERRIDES = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_UNIX_SOCKET',
] as const;

/**
 * The `--settings` of a task on the subscription: the claude.ai login and no
 * other, whatever the repository's own settings say. An empty `apiKeyHelper`
 * replaces one that a repository sets. The base URL is the account's own API
 * rather than empty, because one of the CLI's reads takes an empty value as
 * set (`??`).
 */
export const SUBSCRIPTION_SETTINGS = JSON.stringify({
  forceLoginMethod: 'claudeai',
  apiKeyHelper: '',
  env: {
    ...Object.fromEntries(SAVED_LOGIN_OVERRIDES.map((name) => [name, ''])),
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  },
});

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
  const run = await probeCli(environment, 'claude', AUTH_STATUS_ARGS, {
    env: { ...subscriptionEnvironment(env), CLAUDE_CONFIG_DIR: configDir },
    signal,
  });
  return savedLoginFromStatus(run.stdout, run.exitCode);
}

export const AUTH_STATUS_ARGS = ['auth', 'status', '--json'];

/** The saved login `claude auth status --json` printed. Throws when it printed no status. */
export function savedLoginFromStatus(stdout: string, exitCode: number | null): SavedLogin {
  // The CLI exits 1 with the same JSON when nobody is signed in.
  let status: AuthStatus;
  try {
    status = JSON.parse(stdout) as AuthStatus;
  } catch {
    throw new Error(`claude auth status exited with ${exitCode} and no status`);
  }
  if (status.loggedIn !== true) return 'none';
  return status.authMethod === 'claude.ai' && status.subscriptionType ? 'subscription' : 'other';
}
