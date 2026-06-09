/**
 * Teams Connection Source
 *
 * Thin passthrough over `teams-config` (env-sourced Teams connection).
 * Call sites (`teams-adapter.service`, `teams-mapping.service`) import
 * from here to keep the indirection available if we ever need a non-env
 * source again — same shape as `slack-source.ts`.
 */

import { getTeamsConfig, type TeamsConnectionRecord } from './teams-config';

export async function getActiveTeamsConnections(): Promise<TeamsConnectionRecord[]> {
  const cfg = await getTeamsConfig();
  return cfg ? [cfg] : [];
}

export async function getTeamsConnection(): Promise<TeamsConnectionRecord | null> {
  // Exactly one connection in this runtime. Legacy mappings persisted a
  // TeamsMapping.connectionId that may or may not match the current app id —
  // return the singleton either way since there's nowhere else the
  // credentials could have come from.
  return getTeamsConfig();
}

export type { TeamsConnectionRecord };
