/**
 * Slack Config
 *
 * Slack configuration comes from env (`SLACK_BOT_TOKEN`). At first access
 * we validate the token via Slack's `auth.test` + `bots.info` and cache
 * the resulting `SlackConnectionRecord` singleton. Downstream services
 * (`slack-adapter.service`, `slack-mapping.service`, `slack-thread.provider`)
 * consume the same shape.
 *
 * If `SLACK_EXPECTED_APP_ID` is set, the bot token's `app_id` must match.
 * Unset means "any app accepted".
 */

import { config } from '../config';
import { logger } from '../logger';
import { SlackWebClient } from './slack-web-client';

export interface SlackConnectionRecord {
  id: string;
  teamId: string;
  teamName: string;
  botToken: string;
  botUserId: string;
  installedAt: string;
  isActive: boolean;
}

let cached: SlackConnectionRecord | null | undefined;
let inflight: Promise<SlackConnectionRecord | null> | undefined;

async function loadFromEnv(): Promise<SlackConnectionRecord | null> {
  const botToken = config.slackBotToken;
  if (!botToken) {
    logger.info('[SlackConfig] SLACK_BOT_TOKEN not set — Slack disabled');
    return null;
  }

  // No local shape check: Nexus-injected credentials arrive as
  // `__nexus_cred:<uuid>__` sentinels that get rewritten to real tokens at
  // the MITM proxy on outbound Slack calls. auth.test() below is the real
  // validation — it goes through the proxy and sees the swapped-in token.
  //
  // Boot awaits this call, and nothing else in the process starts until it
  // resolves — the HTTP server included. `SlackWebClient` therefore bounds it
  // (see BOUNDED_SLACK_CLIENT_OPTIONS); the SDK's own defaults would let one
  // hanging Slack request hold the port for ~30 minutes. A tighter deadline than
  // the shared default here: this is a JSON round trip with the port waiting on
  // it, not the file upload the default is sized for.
  const client = new SlackWebClient(botToken, { timeout: 10_000 });
  const authResult = await client.auth.test({});
  const teamId = authResult.team_id || '';
  const teamName = authResult.team || 'Unknown Workspace';
  const botUserId = authResult.user_id || 'unknown';
  if (!teamId) {
    throw new Error('Failed to determine Slack workspace ID from bot token');
  }

  const botId = authResult.bot_id;
  if (!botId) {
    throw new Error('Failed to determine Slack bot ID from bot token');
  }

  // App-id safety check is optional — when unset, any app is accepted.
  if (config.slackExpectedAppId) {
    const botsInfoResult = await client.bots.info({ bot: botId });
    const appId = botsInfoResult.bot?.app_id || '';
    if (!appId) {
      throw new Error('Failed to determine Slack app ID from bot token');
    }
    if (appId !== config.slackExpectedAppId) {
      throw new Error(
        `Slack app ID mismatch: token is from app ${appId}, expected ${config.slackExpectedAppId}`
      );
    }
  }

  logger.info(
    { teamId, teamName, botUserId },
    '[SlackConfig] validated bot token from env'
  );

  return {
    id: teamId, // synthetic id — stable, unique per workspace
    teamId,
    teamName,
    botToken,
    botUserId,
    installedAt: new Date().toISOString(),
    isActive: true,
  };
}

/**
 * Get the env-sourced Slack connection, cached after first successful load.
 * Returns `null` when `SLACK_BOT_TOKEN` is unset (Slack disabled).
 * Throws on validation failure so startup fails loudly.
 */
export async function getSlackConfig(): Promise<SlackConnectionRecord | null> {
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
export function __resetSlackConfigForTests(): void {
  cached = undefined;
  inflight = undefined;
}
