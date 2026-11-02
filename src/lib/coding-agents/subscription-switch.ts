/**
 * Whether a coding agent's tasks run on the subscription signed in to its
 * CLI's home rather than the deployment's models.
 *
 * A sign-in from Coding agents turns it on and a sign-out turns it off; a
 * saved login alone changes nothing. `CLAUDE_CODE_SUBSCRIPTION` and
 * `CODEX_SUBSCRIPTION` hold it on for a deployment that signs in by hand.
 *
 * Stored in `runtime_state` and held here once loaded at boot, because a
 * task's argv is built synchronously.
 */

import { config, CODING_AGENTS, type CodingAgentName } from '../../config';
import { logger } from '../../logger';
import { runtimeStateService } from '../../services/runtime-state.service';

export const subscriptionKey = (agent: CodingAgentName) => `codingAgentSubscription:${agent}`;

const signedIn = new Set<CodingAgentName>();

/** Whether the deployment's environment holds the subscription on. */
export function subscriptionForced(agent: CodingAgentName): boolean {
  return agent === 'claude-code' ? config.claudeCodeSubscription : config.codexSubscription;
}

export function usesSubscription(agent: CodingAgentName): boolean {
  return subscriptionForced(agent) || signedIn.has(agent);
}

/** Read at boot. An unreadable switch stays off, so tasks run on the deployment's models. */
export async function loadSubscriptionSwitches(): Promise<void> {
  for (const agent of CODING_AGENTS) {
    try {
      if ((await runtimeStateService.get(subscriptionKey(agent))) === 'on') signedIn.add(agent);
    } catch (err) {
      logger.warn({ err, agent }, '[CodingAgents] Could not read the subscription switch');
    }
  }
}

export async function setSubscription(agent: CodingAgentName, on: boolean): Promise<void> {
  if (on) await runtimeStateService.set(subscriptionKey(agent), 'on');
  else await runtimeStateService.delete(subscriptionKey(agent));
  if (on) signedIn.add(agent);
  else signedIn.delete(agent);
}
