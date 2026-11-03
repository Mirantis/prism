/**
 * What a task and the desktop's terminal share about the subscription switch:
 * where it is stored, which environment holds it on, and what a coding agent
 * says when it is on and nobody is signed in.
 *
 * Imports nothing that reads the configuration, so the terminal's
 * `coding-agent-exec` loads it without starting the runtime.
 */

import type { CodingAgentName } from '../../config';

/** The `runtime_state` key that holds the switch, `on` or absent. */
export const subscriptionKey = (agent: CodingAgentName) => `codingAgentSubscription:${agent}`;

/** Whether `CLAUDE_CODE_SUBSCRIPTION` or `CODEX_SUBSCRIPTION` holds the switch on. */
export function subscriptionForcedIn(env: NodeJS.ProcessEnv, agent: CodingAgentName): boolean {
  const value = agent === 'claude-code' ? env.CLAUDE_CODE_SUBSCRIPTION : env.CODEX_SUBSCRIPTION;
  return value?.trim().toLowerCase() === 'true';
}

/**
 * What a coding agent says when it is set to use the subscription and nobody is
 * signed in. Coding agents signs in to the home in the deployment's environment;
 * a task in a folder outside it runs on this computer, from `hostHome`, so the
 * message names the command that signs in there instead.
 */
export function notSignedInMessage(agent: CodingAgentName, hostHome?: string): string {
  const setTo =
    agent === 'claude-code'
      ? 'Claude Code is set to use your Claude subscription'
      : 'Codex is set to use your ChatGPT subscription';
  if (!hostHome) return `${setTo}, and nobody is signed in to it: sign in again from Coding agents`;
  const home = `'${hostHome.replaceAll("'", `'\\''`)}'`;
  const command =
    agent === 'claude-code'
      ? `CLAUDE_CONFIG_DIR=${home} claude auth login --claudeai`
      : `CODEX_HOME=${home} codex login -c 'cli_auth_credentials_store="file"'`;
  return (
    `${setTo}, and nobody is signed in to it on this computer, where this conversation's folder is. ` +
    `Coding agents signs in elsewhere: sign in by running \`${command}\` in a terminal on this computer`
  );
}
