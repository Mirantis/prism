/**
 * Teams Config
 *
 * Microsoft Teams configuration comes from env (`TEAMS_APP_ID`,
 * `TEAMS_APP_PASSWORD`, `TEAMS_APP_TENANT_ID`). At first access we build and
 * cache a `TeamsConnectionRecord` singleton that downstream services
 * (`services/teams/teams-adapter.service`, the management routes) consume.
 *
 * Unlike `slack-config.ts` there is no network validation here: credential
 * validation happens inside the Teams SDK's `App.initialize()` (it acquires
 * the bot token), and a failure there leaves the adapter idle rather than
 * failing boot — the same fail-soft posture the Slack adapter has.
 */

import { config } from '../config';
import { logger } from '../logger';

export interface TeamsConnectionRecord {
  /** Synthetic id — the tenant id, stable and unique per tenant. */
  id: string;
  tenantId: string;
  clientId: string;
  name: string;
}

let cached: TeamsConnectionRecord | null | undefined;

function loadFromEnv(): TeamsConnectionRecord | null {
  const { teamsAppId, teamsAppPassword, teamsAppTenantId } = config;
  if (!teamsAppId || !teamsAppPassword || !teamsAppTenantId) {
    logger.info(
      '[TeamsConfig] TEAMS_APP_ID / TEAMS_APP_PASSWORD / TEAMS_APP_TENANT_ID not all set — Teams disabled'
    );
    return null;
  }

  logger.info(
    { clientId: teamsAppId, tenantId: teamsAppTenantId },
    '[TeamsConfig] Teams connection configured from env'
  );

  return {
    id: teamsAppTenantId,
    tenantId: teamsAppTenantId,
    clientId: teamsAppId,
    name: 'Microsoft Teams',
  };
}

/**
 * Get the env-sourced Teams connection, cached after first load.
 * Returns `null` when the Teams env vars are not all set (Teams disabled).
 */
export async function getTeamsConfig(): Promise<TeamsConnectionRecord | null> {
  if (cached !== undefined) return cached;
  cached = loadFromEnv();
  return cached;
}

/**
 * Test-only: reset the cached singleton. Not exported for production use.
 * @internal
 */
export function __resetTeamsConfigForTests(): void {
  cached = undefined;
}
