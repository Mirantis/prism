/**
 * Teams Config
 *
 * Microsoft Teams configuration comes from env (`TEAMS_APP_ID` +
 * `TEAMS_APP_PASSWORD`, optional `TEAMS_APP_TENANT_ID` for single-tenant
 * app registrations). At first access we validate the credentials by
 * acquiring a Bot Framework token from Microsoft Entra ID and cache the
 * resulting `TeamsConnectionRecord` singleton. Downstream services
 * (`teams-adapter.service`, `teams-mapping.service`) consume the same
 * shape — the Teams analogue of `slack-config.ts`.
 */

import { config } from '../config';
import { logger } from '../logger';

export interface TeamsConnectionRecord {
  id: string;
  /** Entra app (client) id of the bot registration */
  appId: string;
  appPassword: string;
  /** Tenant id for single-tenant registrations; null for multi-tenant */
  tenantId: string | null;
  /** Bot Framework id as it appears on activities (`recipient.id`) */
  botId: string;
  displayName: string;
  installedAt: string;
  isActive: boolean;
}

let cached: TeamsConnectionRecord | null | undefined;
let inflight: Promise<TeamsConnectionRecord | null> | undefined;

const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com/.default';

/**
 * Validate the app credentials with a client-credentials token request
 * against Entra ID — the Teams counterpart of Slack's `auth.test`. The
 * CloudAdapter manages its own tokens at runtime; this call exists purely
 * so bad credentials fail loudly at startup instead of on first delivery.
 */
async function validateCredentials(
  appId: string,
  appPassword: string,
  tenantId: string | null,
): Promise<void> {
  const tokenTenant = tenantId || 'botframework.com';
  const url = `https://login.microsoftonline.com/${tokenTenant}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: appId,
    client_secret: appPassword,
    scope: BOT_FRAMEWORK_SCOPE,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Teams credential validation failed (${response.status}): ${detail.slice(0, 300)}`
    );
  }
}

async function loadFromEnv(): Promise<TeamsConnectionRecord | null> {
  const appId = config.teamsAppId;
  const appPassword = config.teamsAppPassword;

  if (!appId || !appPassword) {
    logger.info('[TeamsConfig] TEAMS_APP_ID / TEAMS_APP_PASSWORD not set — Teams disabled');
    return null;
  }

  const tenantId = config.teamsAppTenantId || null;

  await validateCredentials(appId, appPassword, tenantId);

  logger.info(
    { appId, tenantId: tenantId ?? '<multi-tenant>' },
    '[TeamsConfig] validated bot credentials from env'
  );

  return {
    id: appId, // synthetic id — stable, unique per bot registration
    appId,
    appPassword,
    tenantId,
    // Bot Framework prefixes bot ids with "28:" on Teams activities.
    botId: `28:${appId}`,
    displayName: 'Microsoft Teams',
    installedAt: new Date().toISOString(),
    isActive: true,
  };
}

/**
 * Get the env-sourced Teams connection, cached after first successful load.
 * Returns `null` when credentials are unset (Teams disabled).
 * Throws on validation failure so startup fails loudly.
 */
export async function getTeamsConfig(): Promise<TeamsConnectionRecord | null> {
  if (cached !== undefined) return cached;
  if (inflight) return inflight;

  inflight = loadFromEnv()
    .then((record) => {
      cached = record;
      return record;
    })
    .finally(() => {
      inflight = undefined;
    });

  return inflight;
}

/**
 * Test-only: reset the cached singleton. Not exported for production use.
 * @internal
 */
export function __resetTeamsConfigForTests(): void {
  cached = undefined;
  inflight = undefined;
}
