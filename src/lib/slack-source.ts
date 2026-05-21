/**
 * Slack Connection Source
 *
 * Thin passthrough over `slack-config` (env-sourced Slack connection).
 * Call sites (`slack-adapter.service`, `slack-mapping.service`,
 * `slack-thread.provider`) import from here to keep the indirection
 * available if we ever need a non-env source again.
 */

import { getSlackConfig, type SlackConnectionRecord } from './slack-config';

export async function getActiveSlackConnections(): Promise<SlackConnectionRecord[]> {
  const cfg = await getSlackConfig();
  return cfg ? [cfg] : [];
}

export async function getSlackConnection(_id: string): Promise<SlackConnectionRecord | null> {
  // Exactly one connection in this runtime. Callers generally pass the
  // SlackMapping.connectionId they persisted at link time; it may or may
  // not match the current token's teamId. Return the singleton either way
  // — legacy mappings still work since there's nowhere else the token
  // could have come from.
  return getSlackConfig();
}

export type { SlackConnectionRecord };
