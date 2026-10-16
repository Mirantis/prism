import type { ExecutionEnvironment } from '../../execution-environments/execution-environment';
import { captureProgram } from '../../execution-environments/capture';

export const LOGIN_REQUIRED = 'Claude subscription browser login is required. Run claude auth login in the agent sandbox; setup-token and API authentication are not supported.';

export function cleanSubscriptionEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|AWS_|AZURE_|GOOGLE_|VERTEX_)/.test(key)) delete env[key];
  }
  return { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_AUTOUPDATER: '1' };
}

export function subscriptionEnvironment(environment: ExecutionEnvironment): NodeJS.ProcessEnv {
  return { ...cleanSubscriptionEnvironment(environment.baseEnv()), CLAUDE_CONFIG_DIR: environment.paths().claudeHome };
}

export async function requireSubscriptionLogin(environment: ExecutionEnvironment, signal?: AbortSignal): Promise<void> {
  const result = await captureProgram(environment, 'claude', ['auth', 'status'], {
    cwd: environment.workspaceRoot(), env: subscriptionEnvironment(environment),
    timeoutMs: 10_000, limitBytes: 64 * 1024, abortSignal: signal,
  });
  // A CLI that did not run says nothing about the login, so its failure is named as such.
  if (result.error || result.timedOut || result.exitCode !== 0) {
    const reason = result.error?.message ?? (result.timedOut ? 'it timed out' : `it exited with ${result.exitCode}`);
    throw new Error(`The Claude CLI could not report its login in the agent environment: ${reason}.`);
  }
  let account: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string | null };
  try { account = JSON.parse(result.stdout); } catch { throw new Error(LOGIN_REQUIRED); }
  if (!account.loggedIn || account.authMethod !== 'claude.ai' || !account.subscriptionType) throw new Error(LOGIN_REQUIRED);
}
