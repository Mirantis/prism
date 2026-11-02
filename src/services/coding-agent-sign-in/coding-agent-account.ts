/**
 * The subscription signed in to a coding agent's CLI home, as the person is
 * shown it, and signing it out.
 *
 * The email is read for the person's own screen only: it never goes into a
 * message, a log or telemetry.
 */

import type { CodingAgentName } from '../../config';
import { logger } from '../../logger';
import type { ExecutionEnvironment } from '../../lib/execution-environments/execution-environment';
import { probeCli } from '../../lib/coding-agents/cli-probe';
import { subscriptionEnvironment as claudeSubscriptionEnvironment } from '../../lib/coding-agents/claude-code/authenticated-home';
import { subscriptionEnvironment as codexSubscriptionEnvironment } from '../../lib/coding-agents/codex/credentials';

export interface SubscriptionAccount {
  /** Ready to show, e.g. "Claude Max" or "ChatGPT Plus". */
  plan: string;
  email: string;
}

const COMMANDS: Record<CodingAgentName, string> = { 'claude-code': 'claude', codex: 'codex' };

export function homeOf(environment: ExecutionEnvironment, agent: CodingAgentName): string {
  return agent === 'claude-code' ? environment.paths().claudeHome : environment.paths().codexHome;
}

function cliEnvironment(environment: ExecutionEnvironment, agent: CodingAgentName): NodeJS.ProcessEnv {
  const base = environment.baseEnv();
  const home = homeOf(environment, agent);
  return agent === 'claude-code'
    ? { ...claudeSubscriptionEnvironment(base), CLAUDE_CONFIG_DIR: home }
    : { ...codexSubscriptionEnvironment(base), CODEX_HOME: home };
}

const installed = new Map<CodingAgentName, Promise<boolean>>();

/** Whether the coding agent's CLI runs here. Asked once: the image settles it. */
export function cliInstalled(environment: ExecutionEnvironment, agent: CodingAgentName): Promise<boolean> {
  let answer = installed.get(agent);
  if (!answer) {
    answer = probeCli(environment, COMMANDS[agent], ['--version'], { env: environment.baseEnv() })
      .then((run) => run.exitCode === 0)
      .catch(() => false);
    installed.set(agent, answer);
  }
  return answer;
}

/**
 * The plan the login names, "max" as "Claude Max". A login that names none is
 * "ChatGPT plan": no plan is assumed.
 */
export const planName = (prefix: string, type: unknown) =>
  typeof type === 'string' && type.trim()
    ? `${prefix} ${type.trim()[0].toUpperCase()}${type.trim().slice(1)}`
    : `${prefix} plan`;

/** The subscription signed in to the home, or null when none is. Never throws. */
export async function readAccount(
  environment: ExecutionEnvironment,
  agent: CodingAgentName,
): Promise<SubscriptionAccount | null> {
  try {
    return agent === 'claude-code' ? await readClaudeAccount(environment) : await readCodexAccount(environment);
  } catch (err) {
    logger.warn({ err, agent }, '[CodingAgents] Could not read the signed-in account');
    return null;
  }
}

async function readClaudeAccount(environment: ExecutionEnvironment): Promise<SubscriptionAccount | null> {
  try {
    await environment.files.stat(environment.paths().claudeHome);
  } catch {
    return null;
  }
  const run = await probeCli(environment, 'claude', ['auth', 'status', '--json'], {
    env: cliEnvironment(environment, 'claude-code'),
  });
  // The CLI exits 1 with the same JSON when nobody is signed in.
  const status = JSON.parse(run.stdout) as {
    loggedIn?: boolean;
    authMethod?: string;
    email?: string;
    subscriptionType?: string | null;
  };
  if (status.loggedIn !== true || status.authMethod !== 'claude.ai' || !status.subscriptionType) return null;
  return { plan: planName('Claude', status.subscriptionType), email: status.email ?? '' };
}

/** The claims of Codex's saved ChatGPT login that name the account and its plan. */
interface CodexIdClaims {
  email?: string;
  'https://api.openai.com/auth'?: { chatgpt_plan_type?: string };
}

async function readCodexAccount(environment: ExecutionEnvironment): Promise<SubscriptionAccount | null> {
  let saved: { tokens?: { id_token?: string } };
  try {
    saved = JSON.parse(
      await environment.files.readText(`${environment.paths().codexHome}/auth.json`, { maxBytes: 64 * 1024 }),
    ) as typeof saved;
  } catch {
    return null;
  }
  const payload = saved.tokens?.id_token?.split('.')[1];
  if (!payload) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CodexIdClaims;
  return {
    plan: planName('ChatGPT', claims['https://api.openai.com/auth']?.chatgpt_plan_type),
    email: claims.email ?? '',
  };
}

/** Removes the login saved in the home. Throws when the CLI fails to. */
export async function signOutCli(environment: ExecutionEnvironment, agent: CodingAgentName): Promise<void> {
  const args = agent === 'claude-code' ? ['auth', 'logout'] : ['logout', '-c', 'cli_auth_credentials_store="file"'];
  const run = await probeCli(environment, COMMANDS[agent], args, { env: cliEnvironment(environment, agent) });
  if (run.exitCode !== 0 && (await readAccount(environment, agent))) {
    throw new Error(`${COMMANDS[agent]} sign-out exited with ${run.exitCode}`);
  }
}
