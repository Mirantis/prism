/**
 * `claude` and `codex` in the desktop's terminal follow the same subscription
 * switch as tasks: on it, the saved login and nothing that outranks it, and a
 * refusal when nobody is signed in; off it, the deployment's models.
 *
 * Imports nothing that reads the configuration, so `coding-agent-exec` loads
 * it without starting the runtime.
 */

import Database from 'better-sqlite3';
import type { CodingAgentName } from '../../config';
import { resolvePrismaSqlitePath } from '../sqlite-path';
import { AUTH_STATUS_ARGS, SUBSCRIPTION_SETTINGS, savedLoginFromStatus } from './claude-code/authenticated-home';
import { claudeCodeLaunchEnvironment } from './claude-code/environment';
import {
  codexLoginFromStatus,
  LOGIN_STATUS_ARGS,
  subscriptionEnvironment as codexSubscriptionEnvironment,
  SUBSCRIPTION_CONFIG_ARGS,
} from './codex/credentials';
import { subscriptionForcedIn, subscriptionKey } from './subscription';

export type TerminalCommand = 'claude' | 'codex';

export const TERMINAL_COMMANDS: Record<TerminalCommand, CodingAgentName> = {
  claude: 'claude-code',
  codex: 'codex',
};

export function isTerminalCommand(value: string | undefined): value is TerminalCommand {
  return value === 'claude' || value === 'codex';
}

/**
 * Claude Code 2.1's subcommands: none of them is a session, so none takes `--settings`.
 * A subcommand missing here runs as a session: it gets `--settings` and needs
 * the subscription signed in. Update the list from `claude --help` when the
 * image's Claude Code adds one.
 */
const CLAUDE_SUBCOMMANDS = new Set([
  'agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'logs', 'mcp',
  'plugin', 'plugins', 'purge', 'respawn', 'rm', 'setup-token', 'stop', 'kill', 'ultrareview',
  'update', 'upgrade', 'help',
]);

/** Codex's subcommands that never ask a model, so need nobody signed in. */
const CODEX_WITHOUT_MODEL = new Set([
  'login', 'logout', 'completion', 'help', 'mcp', 'features', 'debug', 'sandbox', 'doctor', 'update',
]);

const ASKS_ABOUT_THE_CLI = new Set(['-h', '--help', '-v', '-V', '--version']);

export interface TerminalLaunch {
  env: NodeJS.ProcessEnv;
  args: string[];
  /** Whether it may run only with the subscription signed in. */
  checkLogin: boolean;
}

/** How `command args` runs in the terminal with the switch on or off. */
export function terminalLaunch(
  command: TerminalCommand,
  args: string[],
  env: NodeJS.ProcessEnv,
  subscription: boolean,
): TerminalLaunch {
  const aboutTheCli = args.some((arg) => ASKS_ABOUT_THE_CLI.has(arg));
  if (command === 'claude') {
    const launchEnv = claudeCodeLaunchEnvironment(env, subscription);
    const session = subscription && !CLAUDE_SUBCOMMANDS.has(args[0] ?? '') && !aboutTheCli;
    // The same flag settings as a task, so a repository's settings can't move the session off the login.
    return { env: launchEnv, args: session ? ['--settings', SUBSCRIPTION_SETTINGS, ...args] : args, checkLogin: session };
  }
  if (!subscription) return { env, args, checkLogin: false };
  return {
    env: codexSubscriptionEnvironment(env),
    args: [...SUBSCRIPTION_CONFIG_ARGS, ...args],
    checkLogin: !CODEX_WITHOUT_MODEL.has(args[0] ?? '') && !aboutTheCli,
  };
}

/** The arguments that ask the CLI which login its home holds. */
export function loginStatusArgs(command: TerminalCommand): string[] {
  return command === 'claude' ? AUTH_STATUS_ARGS : LOGIN_STATUS_ARGS;
}

/** Whether the status the CLI printed is the subscription's login. An unreadable status is not. */
export function signedInToSubscription(
  command: TerminalCommand,
  run: { stdout: string; stderr: string; exitCode: number | null },
): boolean {
  try {
    return command === 'claude'
      ? savedLoginFromStatus(run.stdout, run.exitCode) === 'subscription'
      : codexLoginFromStatus(`${run.stdout}\n${run.stderr}`, run.exitCode) === 'chatgpt';
  } catch {
    return false;
  }
}

/** Why the terminal refuses when it can't read the switch and no subscription is signed in. */
export function unreadableSwitchMessage(command: TerminalCommand, err: Error): string {
  const subscription = command === 'claude' ? 'Claude subscription' : 'ChatGPT subscription';
  return `${command}: could not read the Coding agents setting (${err.message}), and no ${subscription} is signed in: sign in from Coding agents`;
}

/**
 * The switch as the runtime stored it, read from the runtime's database
 * opened read-only. Throws when the database can't be read.
 */
export function readSubscriptionSwitch(databaseUrl: string | undefined, agent: CodingAgentName): boolean {
  const db = new Database(resolvePrismaSqlitePath(databaseUrl), { readonly: true, fileMustExist: true, timeout: 2_000 });
  try {
    const row = db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(subscriptionKey(agent)) as
      | { value: string }
      | undefined;
    return row?.value === 'on';
  } finally {
    db.close();
  }
}

/** The switch for the terminal: held on by the environment, or as stored. */
export function terminalUsesSubscription(env: NodeJS.ProcessEnv, agent: CodingAgentName): boolean {
  return subscriptionForcedIn(env, agent) || readSubscriptionSwitch(env.DATABASE_URL, agent);
}
