/**
 * Slack Connection Source
 *
 * Thin abstraction over the two places Slack connection records can come from:
 * - Single-agent mode: env-sourced via `slack-config` (bot token in env,
 *   metadata resolved via Slack's `auth.test` at boot).
 * - Multi-tenant legacy: `backendClient` — fetches from
 *   `lens-agents/backend`'s SlackConnection table.
 *
 * Call sites (`slack-adapter.service`, `slack-mapping.service`,
 * `slack-thread.provider`) import from here instead of hard-coding the source.
 * Once the legacy path is retired, this module collapses to a trivial
 * passthrough over `slack-config` and can be inlined.
 */

import { config } from '../config';
import { backendClient, type SlackConnectionRecord } from './backend-client';
import { getSlackConfig } from './slack-config';

export async function getActiveSlackConnections(): Promise<SlackConnectionRecord[]> {
  if (config.singleAgentMode) {
    const cfg = await getSlackConfig();
    return cfg ? [cfg] : [];
  }
  return backendClient.getActiveSlackConnections();
}

export async function getSlackConnection(id: string): Promise<SlackConnectionRecord | null> {
  if (config.singleAgentMode) {
    const cfg = await getSlackConfig();
    if (!cfg) return null;
    // In single-agent mode there's exactly one connection. Callers generally
    // pass the SlackMapping.connectionId they persisted at link time; it may
    // or may not match the current token's teamId. We return the singleton
    // either way — legacy mappings still work since there's nowhere else the
    // token could have come from.
    return cfg;
  }
  return backendClient.getSlackConnection(id);
}

export type { SlackConnectionRecord };
