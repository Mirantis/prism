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

export function notSignedInMessage(agent: CodingAgentName): string {
  return agent === 'claude-code'
    ? 'Claude Code is set to use your Claude subscription, and nobody is signed in to it: sign in again from Coding agents'
    : 'Codex is set to use your ChatGPT subscription, and nobody is signed in to it: sign in again from Coding agents';
}
