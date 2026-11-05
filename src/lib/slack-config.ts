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
 *
 * In routed mode the token belongs to a proxy, which binds it to a workspace
 * when the agent is added to Slack. Until then `auth.test` answers
 * `invalid_auth`, and the connection stays absent until the router reports the
 * agent connected (`reloadSlackConfig`).
 */

import { config } from '../config';
import { logger } from '../logger';
import { SlackWebClient } from './slack-web-client';

/**
 * How Slack events reach this runtime: over a Socket Mode connection of the
 * app's own, from a router through the `slack` listener, or not at all, which
 * leaves a bot token that only posts.
 */
export type SlackMode = 'socket' | 'routed' | 'post-only';

export function slackMode(): SlackMode {
  if (process.env.SLACK_APP_TOKEN) return 'socket';
  return config.slackApiUrl ? 'routed' : 'post-only';
}

/** The `auth.test` errors of a proxy token that is not bound to a workspace yet. */
const UNBOUND_TOKEN_ERRORS = new Set(['invalid_auth', 'not_authed']);

export interface SlackConnectionRecord {
  id: string;
  teamId: string;
  teamName: string;
  botToken: string;
  botId: string;
  botUserId: string;
  installedAt: string;
  isActive: boolean;
}

let cached: SlackConnectionRecord | null | undefined;
let inflight: Promise<SlackConnectionRecord | null> | undefined;
/**
 * Bumped by every reload and clear. A load started before the bump neither
 * fills the cache nor answers its callers with its own record: a `disconnected`
 * envelope that lands while boot's `auth.test` is still out must not be undone
 * when that call returns.
 */
let generation = 0;

async function loadFromEnv(): Promise<SlackConnectionRecord | null> {
  const botToken = config.slackBotToken;
  if (!botToken) {
    logger.info('[SlackConfig] SLACK_BOT_TOKEN not set — Slack disabled');
    return null;
  }

  // No local shape check: platform-injected credentials arrive as
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
  let authResult: Awaited<ReturnType<typeof client.auth.test>>;
  try {
    authResult = await client.auth.test({});
  } catch (error: unknown) {
    const code = (error as { data?: { error?: string } }).data?.error;
    if (slackMode() === 'routed' && code && UNBOUND_TOKEN_ERRORS.has(code)) {
      logger.info('[SlackConfig] the agent is not in a Slack workspace yet; Slack waits for the router');
      return null;
    }
    throw error;
  }
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
    botId,
    botUserId,
    installedAt: new Date().toISOString(),
    isActive: true,
  };
}

/**
 * Get the env-sourced Slack connection, cached after first successful load.
 * Returns `null` when `SLACK_BOT_TOKEN` is unset (Slack disabled), or while a
 * routed agent is in no Slack workspace.
 * Throws on validation failure so startup fails loudly.
 */
export async function getSlackConfig(): Promise<SlackConnectionRecord | null> {
  if (cached !== undefined) return cached;
  if (inflight) return inflight;

  const started = generation;
  const load: Promise<SlackConnectionRecord | null> = loadFromEnv().then(
    (record) => {
      // A reload or a clear came after this load started: the newer state wins.
      if (started !== generation) return getSlackConfig();
      cached = record;
      inflight = undefined;
      return record;
    },
    (error: unknown) => {
      if (started !== generation) return getSlackConfig();
      inflight = undefined;
      throw error;
    },
  );
  inflight = load;

  return load;
}

/** Validate the token again: the router reported the agent added to a workspace. */
export function reloadSlackConfig(): Promise<SlackConnectionRecord | null> {
  generation++;
  cached = undefined;
  inflight = undefined;
  return getSlackConfig();
}

/** Forget the connection: the router reported the agent removed from its workspace. */
export function clearSlackConfig(): void {
  generation++;
  cached = null;
  inflight = undefined;
}

/**
 * Test-only: reset the cached singleton. Not exported for production use.
 * @internal
 */
export function __resetSlackConfigForTests(): void {
  generation++;
  cached = undefined;
  inflight = undefined;
}
