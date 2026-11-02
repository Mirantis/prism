/**
 * One run of a coding agent's own sign-in command, `claude auth login` or
 * `codex login --device-auth`, read for the link it prints.
 *
 * The person signs in on Anthropic's or OpenAI's page. Claude then shows a
 * code, which goes to the waiting command's stdin and nowhere else; Codex asks
 * the person to type the code it printed on OpenAI's page, and its command
 * ends when they have.
 */

import type { CodingAgentName } from '../../config';
import type { ExecutionEnvironment } from '../../lib/execution-environments/execution-environment';
import { subscriptionEnvironment as claudeSubscriptionEnvironment } from '../../lib/coding-agents/claude-code/authenticated-home';
import { subscriptionEnvironment as codexSubscriptionEnvironment } from '../../lib/coding-agents/codex/credentials';

/** What the person is shown: the page to open, and for Codex the code to enter there. */
export interface SignInPrompt {
  url: string;
  userCode: string | null;
}

/** How the command ended: on its own with success, by refusing the code it was given, or otherwise. */
export type SignInEnd = 'exited' | 'invalid_code' | 'failed';

export interface CliSignIn {
  /** Settles once the command has printed what the person needs; rejects when it ends first. */
  prompt: Promise<SignInPrompt>;
  /** Settles when the command ends, or as soon as it refuses a code. */
  ended: Promise<SignInEnd>;
  /** Claude's code, typed into the waiting command. */
  submitCode(code: string): void;
  kill(): void;
}

/** More than either CLI prints before the link; the rest is not read. */
const OUTPUT_LIMIT = 64 * 1024;

/** The CLIs colour their output and wrap a link in an OSC 8 hyperlink. */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/;
/** The one-time code `codex login --device-auth` prints, e.g. `ABCD-EFGHI`. */
const USER_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;
/** What `claude auth login` prints for a code it refuses. It then keeps waiting for another. */
const INVALID_CODE_PATTERN = /Invalid code/i;

/** The command, its arguments and its environment, run where the home is. */
export function signInCommand(
  agent: CodingAgentName,
  baseEnv: NodeJS.ProcessEnv,
  home: string,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (agent === 'claude-code') {
    return {
      command: 'claude',
      args: ['auth', 'login', '--claudeai'],
      // No browser to open here: the person opens the link on their own device.
      env: { ...claudeSubscriptionEnvironment(baseEnv), CLAUDE_CONFIG_DIR: home, BROWSER: 'false', DISABLE_AUTOUPDATER: '1' },
    };
  }
  return {
    command: 'codex',
    args: ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'],
    env: { ...codexSubscriptionEnvironment(baseEnv), CODEX_HOME: home },
  };
}

/** The link, and for Codex the code, in what the command printed so far; null until all are there. */
export function readPrompt(agent: CodingAgentName, output: string): SignInPrompt | null {
  const text = output.replace(ESCAPES, '');
  const url = URL_PATTERN.exec(text)?.[0];
  if (!url) return null;
  if (agent === 'claude-code') return { url, userCode: null };
  const userCode = USER_CODE_PATTERN.exec(text)?.[0];
  return userCode ? { url, userCode } : null;
}

export function startCliSignIn(
  environment: ExecutionEnvironment,
  agent: CodingAgentName,
  home: string,
): CliSignIn {
  const { command, args, env } = signInCommand(agent, environment.baseEnv(), home);
  const child = environment.runProgram(command, args, {
    cwd: environment.workspaceRoot(),
    env,
    stdin: 'pipe',
  });
  let output = '';
  let codeSent = false;
  let resolvePrompt!: (prompt: SignInPrompt) => void;
  let rejectPrompt!: (err: Error) => void;
  const prompt = new Promise<SignInPrompt>((resolve, reject) => {
    resolvePrompt = resolve;
    rejectPrompt = reject;
  });
  // Rejections are read through `prompt`; this keeps one nobody reads quiet.
  prompt.catch(() => {});
  let settleEnd!: (end: SignInEnd) => void;
  const ended = new Promise<SignInEnd>((resolve) => {
    settleEnd = resolve;
  });

  const read = (chunk: Buffer | string) => {
    if (output.length < OUTPUT_LIMIT) output += chunk.toString();
    const found = readPrompt(agent, output);
    if (found) resolvePrompt(found);
    if (codeSent && INVALID_CODE_PATTERN.test(output)) {
      settleEnd('invalid_code');
      child.kill('SIGTERM');
    }
  };
  child.stdout?.on('data', read);
  child.stderr?.on('data', read);
  // A pipe closed by the command's end is not the sign-in's error.
  child.stdin?.on('error', () => {});
  void child.ended.then((end) => {
    rejectPrompt(new Error(`${command} sign-in ended before it showed a link`));
    settleEnd(!end.error && end.exitCode === 0 ? 'exited' : 'failed');
  });

  return {
    prompt,
    ended,
    submitCode(code: string) {
      // Only what comes after the code is read for a refusal.
      output = '';
      codeSent = true;
      child.stdin?.write(`${code}\n`);
    },
    kill() {
      child.kill('SIGTERM');
    },
  };
}
