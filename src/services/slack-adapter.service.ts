/**
 * Slack Adapter Service (Agent-Runtime)
 *
 * Implements ChannelAdapter for Slack message delivery using Bolt SDK with Socket Mode.
 * Handles incoming Slack messages and routes them through the local conversation engine.
 *
 * Key features:
 * - Socket Mode for real-time bidirectional communication
 * - One Bolt app per connected workspace
 * - Message delivery via DM channel (personal mode) or Slack channel (team mode)
 * - Incoming message handling via local conversationEngineService.chat()
 * - Channel support for team agent participation
 */

import { App, LogLevel, SayFn } from '@slack/bolt';
import { logger } from '../logger';
import prisma from '../lib/prisma';
import { ThreadSource } from '@prisma/client';
import {
  ChannelAdapter,
  ChannelContext,
  ChannelDestination,
  DeliverableMessage,
} from './channel-adapter.interface';
import { AttachmentMeta } from './attachment.service';
import { slackMappingService } from './slack-mapping.service';
import {
  formatSlackMessage,
  buildFeedbackAckBlock,
  FEEDBACK_BLOCK_ID,
  FEEDBACK_ACK_BLOCK_ID,
  FEEDBACK_ACTION_UP,
  FEEDBACK_ACTION_DOWN,
  FEEDBACK_RATING_UP,
  FEEDBACK_RATING_DOWN,
  FeedbackRating,
  FormatSlackMessageOptions,
  SlackBlock,
  slackChannelLabel,
} from '../utils/slack-formatter';
import { trackEvent } from '../lib/telemetry';
import { slackMessageQueueService } from './slack-message-queue.service';
import { slackHeartbeatTriggerService } from './slack-heartbeat-trigger.service';
import { heartbeatService } from './heartbeat.service';
import { conversationService } from './conversation.service';
import { conversationEngineService } from './conversation-engine.service';
import { threadReplyClassifierService, ThreadAction } from './thread-reply-classifier.service';
import { SlackThreadProvider } from './providers/slack-thread.provider';
import { getSlackHeartbeatThrottleQueue } from '../queues/slack-heartbeat-throttle-queue';
import { getActiveSlackConnections, getSlackConnection } from '../lib/slack-source';
import { attachmentService, detectMediaType, classifyMediaType } from './attachment.service';
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB, MAX_ATTACHMENTS_PER_MESSAGE } from '../constants';
import { BOUNDED_SLACK_CLIENT_OPTIONS, stripBodyToken } from '../lib/slack-web-client';
import { getProxyDispatcher } from '../lib/proxy-dispatcher';
import { config } from '../config';
import {
  SlackWorkingIndicator,
  WorkingIndicatorHandle,
  createToolStatusListener,
} from './slack-working-indicator';

// ============================================================================
// Tunables
// ============================================================================

/**
 * Duration (ms) to keep the inline "Thanks for the feedback!" ack visible
 * before auto-removing it via a second chat.update. Short enough to feel
 * transient, long enough that the clicker registers the confirmation.
 */
export const FEEDBACK_ACK_LINGER_MS = 3000;

// ============================================================================
// Types
// ============================================================================

/** The fields of a thread message the gate reads. */
type GateMessage = { user?: string; text?: string; ts?: string };

/**
 * The participation rule's verdict. `respond` passes the message on to the
 * thread classifier; `react` puts 👀 on a message addressed to another person.
 */
type ThreadParticipation = ThreadAction | { action: 'react' };

export interface SlackApp {
  app: App;
  teamId: string;
  teamName: string;
  isSocketMode: boolean;
  botUserId: string;
}

/** Subset of a Slack file object on a message event. */
interface SlackFileMeta {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

/** A file we couldn't ingest, surfaced to the agent so it can tell the user. */
interface SlackFileFailure {
  filename: string;
  reason: string;
}

interface SlackFileDownloadResult {
  attachmentIds: string[];
  failures: SlackFileFailure[];
}

/**
 * Placeholder body for a Slack message whose only content is its file(s).
 * Used for the stored chat message AND the heartbeat-trigger queue, so a file
 * event never becomes an empty-text entry that silently drops the fact that a
 * file was shared.
 */
function describeSharedFiles(files: SlackFileMeta[]): string {
  const names = files.map((f) => f.name || 'file').join(', ');
  return files.length > 1 ? `(shared files: ${names})` : `(shared a file: ${names})`;
}

// ============================================================================
// Slack Adapter Service
// ============================================================================

class SlackAdapterService implements ChannelAdapter {
  readonly name = 'slack';

  /** Active Slack Bolt apps by teamId */
  private apps: Map<string, SlackApp> = new Map();
  /** The boot's Socket Mode starts, settled whether or not they connected. */
  private started: Promise<void> = Promise.resolve();

  // Reads the live Slack thread; used here to await read-consistency. Created
  // lazily (not in a field initializer) because SlackThreadProvider imports
  // this module back — eager construction during that import cycle would see
  // SlackThreadProvider undefined.
  private _slackThreadProvider?: SlackThreadProvider;
  private get slackThreadProvider(): SlackThreadProvider {
    return (this._slackThreadProvider ??= new SlackThreadProvider());
  }

  // Working indicator (thread status, with an eyes-reaction fallback) shown
  // while a user-initiated turn runs.
  private _workingIndicator?: SlackWorkingIndicator;
  private get workingIndicator(): SlackWorkingIndicator {
    return (this._workingIndicator ??= new SlackWorkingIndicator({
      addReaction: (channelId, messageTs, teamId, emoji) =>
        this.addReaction(channelId, messageTs, teamId, emoji),
      removeReaction: (channelId, messageTs, teamId, emoji) =>
        this.removeReaction(channelId, messageTs, teamId, emoji),
      setStatus: (teamId, channelId, threadTs, status) =>
        this.setAssistantStatus(teamId, channelId, threadTs, status),
    }));
  }

  /**
   * Get the Slack Bolt app for a team, once the boot's Socket Mode starts have
   * settled. Work the boot continues reads and delivers before the socket is up,
   * and waits here.
   */
  async getAppForTeam(teamId: string): Promise<SlackApp | undefined> {
    await this.started;
    return this.apps.get(teamId);
  }

  /**
   * List metadata for every connected Slack workspace. Used by the
   * Web UI to display workspace name + bot user on the Channels page.
   */
  listConnectedWorkspaces(): Array<{ teamId: string; teamName: string; botUserId: string }> {
    return [...this.apps.values()].map(({ teamId, teamName, botUserId }) => ({
      teamId,
      teamName,
      botUserId,
    }));
  }

  /** Cache of user connections for quick lookup */
  private userConnectionCache: Map<string, Set<string>> = new Map(); // lensUserId -> teamIds

  /**
   * Deliver a message to the user via Slack DM or channel
   *
   * If channelContext is provided and it's a Slack channel, delivers to that channel.
   * Otherwise, sends to all connected Slack workspaces where the user has a DM mapping.
   */
  async deliver(
    userId: string,
    message: DeliverableMessage,
    channelContext?: ChannelContext
  ): Promise<void> {
    const includeFeedback = channelContext?.includeFeedback === true;
    const attachments = message.attachments ?? [];

    // If channelContext is provided and it's for Slack, deliver to that channel
    if (channelContext?.channel === 'slack' && channelContext.channelId) {
      await this.deliverToChannel(
        channelContext.channelId,
        message.content,
        channelContext.threadId,
        channelContext.channelThreadId,
        (message.toolCalls as Array<{ tool: string }>) ?? undefined,
        message.id,
        includeFeedback,
        attachments,
      );
      trackEvent('slack message delivered', userId, {
        ...(config.agentId ? { 'agent.id': config.agentId } : {}),
        'slack.delivery': 'channel',
      });
      return;
    }

    // Look up agentId from the message's thread to scope delivery
    const thread = await prisma.conversationThread.findUnique({
      where: { id: message.threadId },
      select: { agentId: true },
    });

    // Deliver to active Slack mappings, filtered by agent when possible.
    // Ordered oldest-first so the main-channel fallback below is deterministic.
    const mappings = await prisma.slackMapping.findMany({
      where: {
        lensUserId: userId,
        ...(thread?.agentId && { agentId: thread.agentId }),
      },
      orderBy: { createdAt: 'asc' },
    });

    // Autonomous output (heartbeat, unbound cron) must land in exactly ONE
    // channel — the agent's main channel — never every linked channel, or a
    // heartbeat would spam all of them. Resolve it the same way as everywhere
    // else: the flagged channel, else the oldest linked one as the default.
    const channelMappings = mappings.filter(m => m.slackChannelId);
    const mainChannelId =
      (channelMappings.find(m => m.isMainChannel) ?? channelMappings[0])?.slackChannelId ?? null;

    // One Slack connection (env/DB-backed singleton) — resolve it once up front
    // rather than per mapping. If it's missing or inactive there's nowhere to
    // deliver, so bail before the loop.
    const connection = await getSlackConnection();
    if (!connection || !connection.isActive) {
      if (mappings.length > 0) {
        logger.warn('No active Slack connection — skipping autonomous delivery for user %s', userId);
      }
      return;
    }
    const slackApp = await this.getAppForTeam(connection.teamId);

    for (const mapping of mappings) {
      // Deliver to DM channel (personal mode)
      if (mapping.dmChannelId) {
        if (!slackApp) {
          logger.warn('Slack app not found for team %s', connection.teamId);
          continue;
        }

        try {
          const formatted = await this.prepareOutboundMessage(
            message.content,
            connection.teamId,
            message.triggeredBy || undefined,
            (message.toolCalls as Array<{ tool: string }>) ?? undefined,
            includeFeedback ? { feedbackMessageId: message.id } : undefined,
          );

          const dmResponse = await slackApp.app.client.chat.postMessage({
            channel: mapping.dmChannelId,
            // Reply into the DM thread if the incoming message was in one;
            // undefined posts the reply top-level (existing behavior).
            thread_ts: channelContext?.channelThreadId,
            text: formatted.text,
            blocks: formatted.blocks,
            metadata: {
              event_type: 'lens_platform_message',
              event_payload: {
                messageId: message.id,
                threadId: message.threadId,
                triggeredBy: message.triggeredBy,
              },
            },
          });

          if (dmResponse.ts) {
            await conversationService.setExternalMessageId(message.id, dmResponse.ts);
          }

          // Upload any shared files, threaded under the message just posted.
          await this.uploadAttachmentsToSlack(
            slackApp.app.client,
            mapping.dmChannelId,
            typeof dmResponse.ts === 'string' ? dmResponse.ts : undefined,
            attachments,
          );

          // Slack clears the assistant status on any bot post — set it again.
          // The indicator itself no-ops unless a turn is live on this DM
          // thread; the guard here only ensures there is a thread to target.
          if (channelContext?.channelThreadId) {
            this.workingIndicator.setStatus(
              connection.teamId,
              mapping.dmChannelId,
              channelContext.channelThreadId,
            );
          }

          logger.info('Delivered message to Slack DM %s for user %s', connection.teamName, userId);
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          logger.error('Slack DM delivery failed for %s: %s', connection.teamName, errMsg);
        }
      }

      // Deliver to Slack channel (team mode) — only the main channel, so an
      // autonomous broadcast doesn't fan out to every linked channel.
      if (mapping.slackChannelId && mapping.slackChannelId === mainChannelId) {
        await this.deliverToChannel(
          mapping.slackChannelId,
          message.content,
          message.threadId,
          undefined,
          (message.toolCalls as Array<{ tool: string }>) ?? undefined,
          message.id,
          includeFeedback,
          attachments,
        );
      }
    }

    if (mappings.length > 0) {
      trackEvent('slack message delivered', userId, {
        ...(thread?.agentId ? { 'agent.id': thread.agentId } : {}),
        'slack.delivery': 'mapping',
        'slack.mappings': String(mappings.length),
      });
    }
  }

  /**
   * Deliver a message to a Slack channel (team mode)
   *
   * Used when the agent is participating in a channel conversation.
   */
  async deliverToChannel(
    channelId: string,
    content: string,
    threadId: string,
    threadTs?: string,
    toolCalls?: Array<{ tool: string }>,
    messageId?: string,
    includeFeedback: boolean = false,
    attachments: AttachmentMeta[] = [],
  ): Promise<void> {
    // Find the mapping for this channel. DM channels are keyed by dmChannelId
    // (not slackChannelId), so findByChannelId misses them — fall back to the
    // single Slack connection so thread-bound continuations to a DM still post.
    // (threadDestination resolves the DM channel id here for DM-originated
    // cron/goal "continue in this conversation" resumes.)
    const mapping = await slackMappingService.findByChannelId(channelId);
    const teamId = mapping?.connection.teamId ?? (await getSlackConnection())?.teamId;

    if (!teamId) {
      logger.warn('No Slack connection or channel mapping for channel %s — cannot deliver', channelId);
      return;
    }

    const slackApp = await this.getAppForTeam(teamId);

    if (!slackApp) {
      logger.warn('Slack app not found for team %s', teamId);
      return;
    }

    try {
      const formatted = await this.prepareOutboundMessage(
        content,
        teamId,
        undefined,
        toolCalls,
        includeFeedback && messageId ? { feedbackMessageId: messageId } : undefined,
      );

      const response = await slackApp.app.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs, // Reply in thread if specified
        text: formatted.text,
        blocks: formatted.blocks,
      });

      // Only set external ID when responding in an existing Slack thread.
      // When posting a new top-level message (e.g. heartbeat/cron broadcast),
      // skip setExternalId to avoid corrupting the webchat active thread.
      if (threadTs) {
        logger.info('Setting external thread ID for channel %s ts %s to threadId %s', channelId, threadTs, threadId);
        await conversationService.setExternalId(threadId, threadTs);
      }

      // Link DB record to Slack message for tool call enrichment
      if (messageId && response.ts) {
        await conversationService.setExternalMessageId(messageId, response.ts);
      }

      // Upload any shared files. Thread them under the message we just posted
      // (its ts) when present, else under the reply thread (threadTs).
      await this.uploadAttachmentsToSlack(
        slackApp.app.client,
        channelId,
        typeof response.ts === 'string' ? response.ts : threadTs,
        attachments,
      );

      // Slack clears the assistant status on any bot post — set it again.
      // The indicator itself no-ops unless a turn is live on this thread;
      // the guard here only ensures there is a thread to target.
      if (threadTs) {
        this.workingIndicator.setStatus(teamId, channelId, threadTs);
      }

      logger.info('Delivered message to Slack channel %s', mapping?.slackChannelName || channelId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Slack channel delivery failed for %s: %s', channelId, message);
    }
  }

  /**
   * Upload agent-shared files to Slack via `files.uploadV2`, threaded under
   * `threadTs` when provided so they sit with the message that referenced them.
   *
   * Best-effort: per-file failures are logged, never thrown — the text reply is
   * already delivered and the file stays downloadable on web/CLI. Requires the
   * bot `files:write` scope (add it to the Slack app manifest / OAuth scopes).
   */
  private async uploadAttachmentsToSlack(
    client: App['client'],
    channelId: string,
    threadTs: string | undefined,
    attachments: AttachmentMeta[],
  ): Promise<void> {
    if (attachments.length === 0) return;
    for (const meta of attachments) {
      try {
        const row = await attachmentService.getById(meta.id);
        if (!row) {
          logger.warn('[Slack] shared attachment %s not found; skipping upload', meta.id);
          continue;
        }
        const fileBytes = await attachmentService.loadBytes(row);
        if (!fileBytes) {
          logger.warn('[Slack] shared attachment %s has no content (expired); skipping upload', meta.id);
          continue;
        }
        const uploadBase = {
          channel_id: channelId,
          file: fileBytes,
          filename: row.filename,
        };
        // Concrete branches: the uploadV2 args union requires thread_ts to be a
        // string when present (not an optional), so don't spread it as optional.
        await client.files.uploadV2(
          threadTs ? { ...uploadBase, thread_ts: threadTs } : uploadBase,
        );
        logger.info('[Slack] uploaded shared file %s to %s', meta.filename, channelId);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error('[Slack] failed to upload shared file %s to %s: %s', meta.filename, channelId, msg);
      }
    }
  }

  /**
   * Check if user has an active Slack connection
   */
  async isUserConnected(userId: string): Promise<boolean> {
    // Check cache first
    const cachedTeams = this.userConnectionCache.get(userId);
    if (cachedTeams && cachedTeams.size > 0) {
      return true;
    }

    // Query database via slackMappingService (includes both DM and channel mappings)
    const count = await slackMappingService.countAllMappings(userId);
    return count > 0;
  }

  /**
   * A Slack thread continues where it started. A DM-originated thread carries
   * no channel id (the DM path does not capture one, and DM threads have no
   * externalChannelId). Without one, `deliver` falls back to its mapping
   * broadcast, which can also post into the user's linked channels, so the
   * user's DM channel is resolved to keep the continuation in the DM.
   */
  async threadDestination(threadId: string, originChannelId?: string): Promise<ChannelDestination> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { externalThreadId: true, externalChannelId: true, threadSource: true, userId: true, agentId: true },
    });
    let channelId = originChannelId ?? thread?.externalChannelId ?? undefined;
    if (!channelId && thread) {
      const dm = await prisma.slackMapping.findFirst({
        where: { lensUserId: thread.userId, agentId: thread.agentId, dmChannelId: { not: null } },
        select: { dmChannelId: true },
      });
      channelId = dm?.dmChannelId ?? undefined;
    }
    // With no channel id there is nowhere to post, and the resume is dropped. A
    // thread-bound task resumes in its own thread or not at all: the main
    // channel would put its output in an unrelated conversation.
    if (!channelId) {
      logger.warn(
        'No Slack channel resolved for thread %s (no origin/external channel id and no DM mapping) — a "continue in thread" resume will not be delivered',
        threadId,
      );
    }
    return {
      channelId,
      channelLabel: channelId ? slackChannelLabel(channelId) : undefined,
      // Only SLACK-sourced threads keep a real thread_ts in externalThreadId.
      // A top-level DM thread is DATABASE-sourced and stores its `D…` channel
      // id there, which is no thread_ts, so it resumes top-level in the DM.
      channelThreadId:
        thread?.threadSource === ThreadSource.SLACK ? (thread.externalThreadId ?? undefined) : undefined,
    };
  }

  /**
   * The user's DM channel, else the agent's main linked channel. No channel id
   * goes with it: `deliver`'s mapping fallback posts to the DM or the main
   * channel, while a channel id routes to `deliverToChannel`, which cannot post
   * to a DM.
   */
  async defaultDestination(
    agentId: string,
    userId: string,
  ): Promise<(ChannelDestination & { threadKey: string }) | null> {
    const dm = await prisma.slackMapping.findFirst({
      where: { lensUserId: userId, agentId, dmChannelId: { not: null } },
      select: { dmChannelId: true },
    });
    const conversation = dm?.dmChannelId ?? (await slackMappingService.getMainChannel(agentId));
    return conversation ? { threadKey: conversation } : null;
  }

  async linkedChannelIds(agentId: string): Promise<string[]> {
    return slackMappingService.listChannelIds(agentId);
  }

  /**
   * Initialize Slack adapter
   *
   * Loads all active Slack connections from the database and creates
   * Bolt apps with Socket Mode for each workspace.
   */
  async initialize(): Promise<void> {
    logger.info('Initializing Slack adapter...');

    try {
      // Source of truth: env `SLACK_BOT_TOKEN` (validated by slack-config).
      // An empty list is the not-configured case.
      const connections = await getActiveSlackConnections();
      if (connections.length === 0) {
        logger.info('No active Slack connections; adapter idle');
        return;
      }

      // Boot does not wait for the sockets: `app.start()` can wait on
      // `apps.connections.open` with no time limit, and the HTTP port opens after
      // this returns. A workspace is listed once its socket is up.
      const started = connections.map((connection) =>
        this.initializeConnection(connection.id).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('Failed to initialize Slack connection for %s: %s', connection.teamName, message);
        }),
      );

      // Build user connection cache
      await this.rebuildUserCache();

      this.started = Promise.all(started).then(() => undefined);
      void this.started.then(() => {
        logger.info('Slack adapter initialized: %d workspace(s)', this.apps.size);
        trackEvent('slack adapter initialized', null, {
          ...(config.agentId ? { 'agent.id': config.agentId } : {}),
          'slack.workspaces': String(this.apps.size),
        });
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to initialize Slack adapter: %s', message);
    }
  }

  /**
   * Shutdown Slack adapter
   *
   * Stops all Bolt apps gracefully.
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Slack adapter...');

    // Clear working indicators while the Bolt clients are still up, so the
    // best-effort reaction removals / status clears can reach Slack.
    await this._workingIndicator?.stopAll();
    // A stopped indicator refuses new turns for good — drop the instance so
    // a later initialize()/add-connection in the same process (management
    // API restart, not just process exit) gets a fresh one from the getter.
    this._workingIndicator = undefined;

    for (const [teamId, slackApp] of this.apps) {
      try {
        if (slackApp.isSocketMode) {
          await slackApp.app.stop();
        }
        logger.info('Stopped Slack app for %s', slackApp.teamName);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to stop Slack app for %s: %s', teamId, message);
      }
    }

    const workspaces = this.apps.size;
    this.apps.clear();
    this.userConnectionCache.clear();

    trackEvent('slack adapter shutdown', null, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'slack.workspaces': String(workspaces),
    });
  }

  /**
   * Initialize a single Slack connection
   *
   * Creates a Bolt app with the stored tokens and sets up message handlers.
   */
  async initializeConnection(connectionId: string): Promise<void> {
    const connection = await getSlackConnection();

    if (!connection || !connection.isActive) {
      return;
    }

    // Bot token comes from env via slack-config (plaintext, or a
    // `__nexus_cred:…__` sentinel that the MITM swaps on the wire).
    const botToken = connection.botToken;

    // App token is global (from environment), not per-workspace
    const appToken = process.env.SLACK_APP_TOKEN;

    // Determine if Socket Mode is available
    const isSocketMode = Boolean(appToken);

    // Create Bolt app. clientOptions forwards to the internal WebClient:
    //   - `fetch: stripBodyToken`: drops the `token` field
    //     from outbound bodies so bot-token auth flows only via
    //     `Authorization` header — required when the bot token is a
    //     platform `__nexus_cred:<uuid>__` sentinel (header-only rewrite).
    //   - `BOUNDED_SLACK_CLIENT_OPTIONS`: a request deadline and a few
    //     seconds-scale retries instead of the SDK's `timeout: 0` +
    //     ~30 minutes of them, for every post. `app.start()` still waits on
    //     `apps.connections.open` under the SDK's own `timeout: 0`, which is
    //     why `initialize()` does not wait for it.
    //
    // `installerOptions.clientOptions` is deliberately *not* those bounds. Bolt
    // defaults that field to `clientOptions` (App.js: `{ clientOptions: this.clientOptions,
    // ...installerOptions }`) and `SocketModeReceiver` hands it straight to
    // `SocketModeClient`, which (a) keeps its own `{ retries: 100, factor: 1.3 }`
    // policy for `apps.connections.open` only while `retryConfig` is undefined and
    // (b) treats a request timeout as unrecoverable — no reconnect, and the
    // rejection lands in an uncaught `setTimeout` on the reconnect path. Bounding
    // that client would trade a rare 30-minute boot stall for a bot that silently
    // stops receiving after any blip, so the socket keeps the SDK's policy and
    // only inherits the body-token strip. Consequences of it being a separate
    // literal: anything the socket leg also needs — a proxying `fetch`, say —
    // has to be added to *both*, and its WebClient logs through a plain
    // level-matched logger rather than Bolt's named one.
    //
    // `botId` and `botUserId` come from the boot's `auth.test`. Without them the
    // App constructor runs its own `auth.test`, and a failure of that call is an
    // unhandled rejection, which ends the process during an outage.
    const app = new App({
      token: botToken,
      botId: connection.botId,
      botUserId: connection.botUserId,
      ...(isSocketMode && {
        appToken,
        socketMode: true,
      }),
      clientOptions: { ...BOUNDED_SLACK_CLIENT_OPTIONS, fetch: stripBodyToken },
      installerOptions: { clientOptions: { fetch: stripBodyToken } },
      logLevel: process.env.NODE_ENV === 'production' ? LogLevel.WARN : LogLevel.INFO,
    });

    // Handle async errors from Socket Mode to prevent process crash
    app.error(async (error) => {
      logger.error('Slack app error for %s: %s', connection.teamName, error instanceof Error ? error.message : String(error));
    });

    // Set up message handlers
    this.setupMessageHandler(app, connectionId, connection.botUserId, connection.teamId);
    this.setupChannelEventHandlers(app, connectionId, connection.botUserId);
    this.setupFeedbackActionHandlers(app);

    // Start Socket Mode if available
    if (isSocketMode) {
      try {
        await app.start();
        logger.info('Slack Socket Mode connected: %s', connection.teamName);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Slack Socket Mode failed for %s. The server will continue without this Slack connection: %s', connection.teamName, message);
        return;
      }
    } else {
      logger.warn('Slack connection %s - Socket Mode not available (no app token)', connection.teamName);
    }

    this.apps.set(connection.teamId, {
      app,
      teamId: connection.teamId,
      teamName: connection.teamName,
      isSocketMode,
      botUserId: connection.botUserId,
    });

    trackEvent('slack connection added', null, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'slack.connection.id': connectionId,
      'slack.socket_mode': String(isSocketMode),
    });
  }

  /**
   * Set up message handler for incoming Slack DM messages
   */
  private setupMessageHandler(app: App, connectionId: string, botUserId: string, teamId: string): void {
    logger.info('Setting up message handler for team %s, bot %s', teamId, botUserId);

    // Handle direct messages to the bot
    app.message(async ({ message, say }) => {
      try {
        logger.info('RAW Slack message received');

      // Type guard for message events
      const msg = message as {
        subtype?: string;
        user?: string;
        text?: string;
        channel: string;
        channel_type?: string;
        bot_id?: string;
        thread_ts?: string;
        ts: string;
        files?: SlackFileMeta[];
      };

      const hasFiles = Array.isArray(msg.files) && msg.files.length > 0;

      // Skip message subtypes (edits, deletes, etc.) — except `file_share`,
      // which is how a user-uploaded attachment arrives (often with empty text).
      if (msg.subtype && msg.subtype !== 'file_share') {
        logger.info('Skipping message with subtype: %s', msg.subtype);
        return;
      }
      // Require a user; allow empty text when the message carries files.
      if (!msg.user || (!msg.text && !hasFiles)) {
        logger.info('Skipping message without user or content');
        return;
      }
      // In e2e tests, user tokens from Slack apps attach bot_id to every message.
      // SLACK_SKIP_BOT_ID_CHECK=true relaxes this to only skip the bot's own messages.
      if (msg.bot_id) {
        if (process.env.SLACK_SKIP_BOT_ID_CHECK === 'true') {
          if (msg.user === botUserId) {
            logger.info('Skipping own bot message');
            return;
          }
        } else {
          logger.info('Skipping bot message');
          return;
        }
      }

      const slackUserId: string = msg.user;
      const messageText: string = (msg.text || '').trim();
      const channelId: string = msg.channel;
      const files: SlackFileMeta[] = hasFiles ? msg.files! : [];

      logger.info('Processing message: channel=%s, channel_type=%s, files=%d', channelId, msg.channel_type, files.length);

      if (!messageText && files.length === 0) {
        logger.info('Skipping empty message');
        return;
      }

      // Route based on channel type
      if (msg.channel_type === 'im') {
        logger.info('Routing to DM handler');
        // DM message - existing logic
        await this.handleDmMessage(connectionId, slackUserId, messageText, channelId, say, teamId, msg.ts, msg.thread_ts, files);
      } else {
        logger.info('Routing to channel handler');
        // Channel message - route to channel handler
        await this.handleChannelMessage(
          connectionId,
          channelId,
          slackUserId,
          messageText,
          msg.thread_ts,
          msg.ts,
          say,
          botUserId,
          teamId,
          files
        );
      }
      } catch (error) {
        // Re-extract context from the raw event — locals above are scoped inside the try.
        const rawMsg = message as { channel?: string; channel_type?: string; user?: string; ts?: string };
        logger.error(
          {
            err: error,
            connectionId,
            teamId,
            channel: rawMsg.channel,
            channelType: rawMsg.channel_type,
            slackUserId: rawMsg.user,
            eventTs: rawMsg.ts,
          },
          'Error in message handler'
        );
      }
    });
  }

  /**
   * Handle DM messages (personal agent mode)
   */
  private async handleDmMessage(
    connectionId: string,
    slackUserId: string,
    messageText: string,
    dmChannelId: string,
    say: SayFn,
    teamId: string,
    eventTs?: string,
    threadTs?: string,
    files: SlackFileMeta[] = []
  ): Promise<void> {
    logger.info('Slack DM from %s', slackUserId);

    let indicator: WorkingIndicatorHandle | null = null;
    try {
      // Check if this looks like a verification code (6 hex chars, possibly with formatting)
      // Strip common Slack formatting: *bold*, _italic_, ~strike~
      const strippedText = messageText.replace(/[*_~`]/g, '').trim();
      const codeMatch = strippedText.match(/^[A-Fa-f0-9]{6}$/);
      if (codeMatch) {
        const code = strippedText.toUpperCase();
        // Verify directly using local service (agent-runtime owns verification)
        const result = await this.verifyDmLinkCode(code, slackUserId, dmChannelId);

        if (result.success) {
          await say(`✅ ${result.message}`);
          // Rebuild user cache after linking
          await this.rebuildUserCache();
        } else {
          await say(`❌ ${result.message}`);
        }
        return;
      }

      // Find the user mapping for this Slack user
      const mapping = await slackMappingService.findUserMapping(connectionId, slackUserId);

      if (!mapping) {
        logger.info(
          'Slack DM from unlinked user %s (connection %s) — message not handled; prompting them to link their account',
          slackUserId,
          connectionId,
        );
        await say(
          "👋 Hi! I don't recognize you yet.\n\nTo link your Prism Agent account:\n1. Go to *Settings → Channels* in the web app\n2. Click *Link Account* under Slack\n3. Send me the 6-character code you receive"
        );
        return;
      }

      // Working cue for the whole turn. No statusThreadTs for a top-level DM
      // (never synthesized from eventTs — that could activate a Slack
      // assistant thread prematurely); the eyes reaction covers it.
      indicator = await this.workingIndicator.begin({
        teamId,
        channelId: dmChannelId,
        messageTs: eventTs,
        statusThreadTs: threadTs,
      });

      // Store DM channel ID if not already stored
      if (!mapping.dmChannelId) {
        await slackMappingService.updateDmChannelId(mapping.id, dmChannelId);
      }

      // Resolve user mentions to display names
      const resolvedText = await this.resolveMentions(messageText, teamId);

      // Download any uploaded attachments into our DB (linked to the user
      // message inside chat()). A message with only files gets a placeholder
      // body. Failed downloads are surfaced to the agent via runtimeNotices
      // (system prompt) so it reliably tells the user instead of the file
      // silently vanishing.
      const { attachmentIds, failures } = await this.downloadSlackFiles(files, { externalTs: eventTs });
      const sharedSomething = attachmentIds.length > 0 || failures.length > 0;
      const effectiveText = resolvedText || (sharedSomething ? describeSharedFiles(files) : resolvedText);

      // Look up the sender's Slack identity and tag the message with the
      // sender's <@USERID:Name> marker so the agent can emit a real
      // mention back to them on reply.
      const senderInfo = await this.getUserInfo(slackUserId, teamId);
      const taggedText = this.buildSenderTaggedContent(
        slackUserId,
        senderInfo?.real_name || senderInfo?.name,
        effectiveText,
      );

      // Resolve a dedicated DM thread so Slack DM history stays out of the
      // webchat ACTIVE thread (which is keyed by externalThreadId: null).
      //   - Top-level DM turn (no thread_ts) → key by dmChannelId, threadSource
      //     stays DATABASE. All top-level turns share one ongoing
      //     ConversationThread; DatabaseThreadProvider serves its history from
      //     Prisma (where we persist every turn).
      //   - Threaded DM turn (thread_ts present) → key by thread_ts AND pass
      //     { channelId } so threadSource flips to SLACK. Reads then flow
      //     through SlackThreadProvider.fetchAllReplies(dmChannelId, thread_ts),
      //     returning the parent message + all replies straight from Slack.
      //     Without this the parent lives on the top-level ConversationThread
      //     row and is invisible to the threaded turn's context builder.
      const threadKey = threadTs ?? dmChannelId;
      const dmThread = await conversationService.getOrCreateThreadByExternalId(
        mapping.lensUserId!,
        mapping.agentId,
        threadKey,
        threadTs ? { source: ThreadSource.SLACK, channelId: dmChannelId } : undefined,
      );

      // Route through local conversation engine (direct call).
      // metadata.channel='slack' scopes delivery to Slack only; channelThreadId
      // makes the reply land in the same DM thread (undefined → top-level).
      await conversationEngineService.chat({
        userId: mapping.lensUserId!,
        agentId: mapping.agentId,
        threadId: dmThread.id,
        message: taggedText,
        attachmentIds,
        runtimeNotices: failures.length ? [this.buildAttachmentFailureNote(failures)] : undefined,
        onToolEvent: indicator ? createToolStatusListener(indicator) : undefined,
        metadata: { channel: 'slack', channelThreadId: threadTs },
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          err: error,
          slackUserId,
          channel: dmChannelId,
          connectionId,
          teamId,
          eventTs,
        },
        'Slack DM processing error'
      );
      await say(`Sorry, I encountered an error processing your message: ${errMsg}`);
    } finally {
      await indicator?.end();
    }
  }

  /**
   * Handle channel messages (team agent mode)
   *
   * Only respond in threads the bot takes part in or when mentioned
   */
  private async handleChannelMessage(
    connectionId: string,
    channelId: string,
    slackUserId: string,
    messageText: string,
    threadTs: string | undefined,
    messageTs: string,
    say: SayFn,
    botUserId: string,
    teamId: string,
    files: SlackFileMeta[] = []
  ): Promise<void> {
    // Check if this looks like a verification code FIRST (before channel link check)
    // This allows linking an unlinked channel
    // Strip bot mention first so "@Bot ABC123" is detected as a verification code
    const textForCodeCheck = messageText.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
    const strippedText = textForCodeCheck.replace(/[*_~`]/g, '').trim();
    if (this.isVerificationCode(strippedText)) {
      logger.info('Received potential verification code in channel %s', channelId);
      const result = await this.verifyAndLinkChannel(strippedText.toUpperCase(), channelId, slackUserId, teamId);
      try {
        await say(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
      } catch (sayError) {
        logger.warn('Failed to post verification result in channel %s: %s', channelId, sayError instanceof Error ? sayError.message : String(sayError));
      }
      return;
    }

    // File-only messages reach the queue paths below with empty text — those
    // paths never download files, so describe them instead of enqueueing ''
    // (which would render as an empty heartbeat entry while the file
    // silently vanishes).
    const queueText = messageText || (files.length > 0 ? describeSharedFiles(files) : messageText);

    // Check if this channel is a heartbeat trigger channel (direct local call)
    const triggerCheck = await slackHeartbeatTriggerService.isHeartbeatTriggerChannel(channelId);

    if (triggerCheck.isTrigger) {
      logger.info(`[SlackAdapter] Heartbeat trigger received in channel ${channelId} for agent ${triggerCheck.agentId}`);
      const userInfo = await this.getUserInfo(slackUserId, teamId);
      const senderName = userInfo?.real_name || userInfo?.name || slackUserId;

      await slackMessageQueueService.enqueue(triggerCheck.agentId!, {
        sender: senderName,
        text: queueText,
        timestamp: new Date().toISOString(),
      });
      // Fire-and-forget: throttle errors shouldn't surface to the user
      // since the message was already enqueued successfully
      this.throttledNotify(triggerCheck.agentId!).catch((err) => {
        logger.error('[SlackAdapter] throttledNotify failed for agent %s: %s', triggerCheck.agentId, err instanceof Error ? err.message : String(err));
      });
      return;
    }

    // Check if channel is linked to an agent
    const mapping = await slackMappingService.findByChannelId(channelId);
    if (!mapping) {
      logger.info('Slack channel %s is not linked to an agent — message not handled', channelId);
      // Channel not linked — if the bot was @mentioned, prompt the user to link
      if (messageText.includes(`<@${botUserId}>`)) {
        await say("I'm not activated in this channel yet.\n\nPlease enter a verification code from your agent settings to link me.");
      }
      return;
    }

    // For channel mappings, lensUserId is the agent owner who linked the channel
    // This must be set - do not fall back to connection.userId (which is the admin who installed the app)
    if (!mapping.lensUserId) {
      logger.warn('Channel mapping for %s has no lensUserId - skipping (legacy mapping?)', channelId);
      if (messageText.includes(`<@${botUserId}>`)) {
        await say("This channel has an incomplete configuration. Please unlink and re-link the channel.");
      }
      return;
    }
    const userId = mapping.lensUserId;

    // Check if mentioned in the message
    const isMentioned = messageText.includes(`<@${botUserId}>`);

    logger.info(
      'Slack channel message from %s in %s (threadTs=%s, isMentioned=%s, botUserId=%s, text=%s)',
      slackUserId,
      mapping.slackChannelName || channelId,
      threadTs ?? 'none',
      isMentioned,
      botUserId,
      messageText.slice(0, 80)
    );

    // For top-level messages (not in a thread), only respond if mentioned
    if (!threadTs && !isMentioned) {
      logger.info(
        'Channel message not answered: top-level message without bot mention (agent=%s, channel=%s)',
        mapping.agentId,
        mapping.slackChannelName || channelId
      );
      return;
    }

    // For thread messages, check if bot is participating in the thread
    if (threadTs && !isMentioned) {
      // `conversations.replies` is eventually consistent, so the gate is given
      // the message it must judge rather than relying on the read to hold it.
      const { result, messages } = await this.isBotInThread(
        channelId,
        threadTs,
        mapping.connection.teamId,
        { user: slackUserId, text: queueText, ts: messageTs },
      );

      if (result.action === 'ignore') {
        logger.info(
          'Channel message not answered: thread message where bot is not participating (agent=%s, channel=%s)',
          mapping.agentId,
          mapping.slackChannelName || channelId
        );
        return;
      }

      if (result.action === 'react') {
        await this.addReaction(channelId, messageTs, mapping.connection.teamId, 'eyes');
        logger.info(
          'Channel message not answered: thread message addressed to another person, reacted (agent=%s, channel=%s)',
          mapping.agentId,
          mapping.slackChannelName || channelId
        );
        return;
      }

      // result.action === 'respond' — double-check with LLM
      const llmResult = await this.classifyThreadMessage(messages, botUserId, mapping.agentId);

      if (llmResult.action === 'ignore') {
        logger.info(
          'Channel message not answered: LLM classifier decided to ignore thread message (agent=%s, channel=%s)',
          mapping.agentId,
          mapping.slackChannelName || channelId
        );
        return;
      }
    }

    // Bot should respond - process through conversation engine
    const slackThreadId = threadTs || messageTs;
    let indicator: WorkingIndicatorHandle | null = null;
    try {
      // Working cue for the whole turn — started before the (possibly slow)
      // read-consistency wait below so the user sees it immediately. The
      // reply always lands in slackThreadId's thread, so the status line
      // attaches there; the fallback reaction, when the status cannot be
      // set, trails it by one Slack round trip.
      indicator = await this.workingIndicator.begin({
        teamId: mapping.connection.teamId,
        channelId,
        messageTs,
        statusThreadTs: slackThreadId,
      });

      // Get or create thread bound to this Slack thread
      const thread = await conversationService.getOrCreateThreadByExternalId(
        userId, mapping.agentId, slackThreadId, { source: ThreadSource.SLACK, channelId }
      );

      // Add participant tracking
      const userInfo = await this.getUserInfo(slackUserId, mapping.connection.teamId);
      await this.addParticipant(thread.id, slackUserId, userInfo?.real_name || userInfo?.name || 'Unknown');

      // Strip bot mention only, then resolve remaining user mentions to display names
      const withoutBot = messageText.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
      const text = await this.resolveMentions(withoutBot, mapping.connection.teamId);

      // Download any uploaded attachments. `externalTs` is the carrying
      // message's ts so the live-read SlackThreadProvider can re-associate
      // them on later turns; `threadId` scopes that lookup.
      const { attachmentIds, failures } = await this.downloadSlackFiles(files, {
        externalTs: messageTs,
        threadId: thread.id,
      });
      const sharedSomething = attachmentIds.length > 0 || failures.length > 0;
      const effectiveText = text || (sharedSomething ? describeSharedFiles(files) : text);
      const senderName = userInfo?.real_name || userInfo?.name;
      const taggedText = this.buildSenderTaggedContent(slackUserId, senderName, effectiveText);

      // Slack's conversations.replies is eventually consistent: the message we
      // just received may not be returned by the live thread read for a few
      // seconds. Wait (bounded, exponential backoff up to 30s) for it to be
      // visible before the engine builds context, so the assembled history ends
      // on the user's turn rather than the bot's previous reply (which Bedrock
      // rejects: "the conversation must end with a user message"). Throws on
      // timeout — surfaced to the user by the catch below — so we never respond
      // to stale context.
      await this.slackThreadProvider.waitForExternalMessage(thread.id, messageTs);

      // Route through local conversation engine (direct call)
      await conversationEngineService.chat({
        userId,
        agentId: mapping.agentId,
        threadId: thread.id,
        message: taggedText,
        attachmentIds,
        runtimeNotices: failures.length ? [this.buildAttachmentFailureNote(failures)] : undefined,
        onToolEvent: indicator ? createToolStatusListener(indicator) : undefined,
        metadata: {
          channel: 'slack',
          channelId,
          channelThreadId: slackThreadId,
          channelLabel: slackChannelLabel(mapping.slackChannelName ?? channelId),
          senderExternalId: slackUserId,
          senderName,
        },
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          err: error,
          slackUserId,
          channel: channelId,
          connectionId,
          teamId,
          threadTs,
          messageTs,
        },
        'Slack channel message processing error'
      );
      await say({
        text: `Sorry, I encountered an error: ${errMsg}`,
        thread_ts: slackThreadId,
      });
    } finally {
      await indicator?.end();
    }
  }

  /**
   * Register Slack Block Kit action handlers for 👍/👎 feedback buttons.
   *
   * Socket Mode delivers block_actions events on the existing Bolt app, so no
   * HTTP endpoint or signing-secret wiring is needed.
   *
   * On click:
   *   1. ack() the interaction
   *   2. resolve the ConversationMessage by externalMessageId (= body.message.ts)
   *   3. emit 'message feedback' via the OTEL telemetry pipeline with userId=null
   *      (we have no reliable Slack-user → Lens-user mapping) and the raw
   *      Slack user id recorded as the 'slack.user.id' property
   *   4. chat.update the Slack message: swap the actions block for an inline
   *      'Thanks for the feedback!' context block. Visible to everyone in the
   *      channel thread — also serves as idempotency (buttons gone → no more
   *      clicks).
   */
  private setupFeedbackActionHandlers(app: App): void {
    const handler = (rating: FeedbackRating) => async ({ ack, body, client }: {
      ack: () => Promise<void>;
      body: unknown;
      client: { chat: { update: (args: unknown) => Promise<unknown> } };
    }): Promise<void> => {
      await ack();

      try {
        await this.handleFeedbackAction(body, client, rating);
      } catch (error) {
        logger.error(
          '[SlackAdapter] Feedback action handler failed: %s',
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.action(FEEDBACK_ACTION_UP, handler(FEEDBACK_RATING_UP) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.action(FEEDBACK_ACTION_DOWN, handler(FEEDBACK_RATING_DOWN) as any);
  }

  /**
   * Core feedback-click logic (separated so it can be unit-tested without Bolt).
   */
  async handleFeedbackAction(
    body: unknown,
    client: { chat: { update: (args: unknown) => Promise<unknown> } },
    rating: FeedbackRating,
  ): Promise<void> {
    const payload = body as {
      user?: { id?: string };
      channel?: { id?: string };
      message?: { ts?: string; text?: string; blocks?: Array<{ block_id?: string; type?: string }> };
      actions?: Array<{ action_id?: string; value?: string }>;
    };

    const action = payload.actions?.[0];
    const slackUserId = payload.user?.id;
    const channelId = payload.channel?.id;
    const messageTs = payload.message?.ts;
    const messageId = action?.value;

    if (!action || !slackUserId || !channelId || !messageTs || !messageId) {
      logger.warn('[SlackAdapter] Feedback payload missing required fields');
      return;
    }

    // Resolve the ConversationMessage + thread to capture agent/thread attrs for telemetry.
    const conversationMessage = await prisma.conversationMessage.findFirst({
      where: { id: messageId, externalMessageId: messageTs },
      include: { thread: { select: { agentId: true } } },
    });

    if (!conversationMessage) {
      logger.warn(
        '[SlackAdapter] Feedback click for unknown message id=%s ts=%s',
        messageId,
        messageTs,
      );
      // Still acknowledge so the user isn't left with dangling buttons.
      await this.replaceFeedbackButtonsWithAck(client, channelId, messageTs, payload.message);
      return;
    }

    trackEvent('message feedback', null, {
      'message.id': messageId,
      'thread.id': conversationMessage.threadId,
      'agent.id': conversationMessage.thread.agentId,
      'channel.type': 'slack',
      'feedback.rating': rating,
      'feedback.source': 'slack_blockkit',
      'slack.user.id': slackUserId,
    });

    await this.replaceFeedbackButtonsWithAck(client, channelId, messageTs, payload.message);
  }

  /**
   * Swap the feedback actions block on the original Slack message for an
   * inline generic "Thanks for the feedback!" context block via chat.update,
   * then auto-remove that ack block after FEEDBACK_ACK_LINGER_MS so the
   * message returns to a clean state.
   *
   * Visible to everyone in channel/team mode while the ack lingers — gives
   * other viewers a transient "feedback was recorded" signal without
   * revealing which rating was given. Also serves as idempotency: the buttons
   * are removed on the first update so no further clicks are possible (the
   * first rater's rating is the one captured in telemetry).
   */
  private async replaceFeedbackButtonsWithAck(
    client: { chat: { update: (args: unknown) => Promise<unknown> } },
    channelId: string,
    messageTs: string,
    original: { text?: string; blocks?: Array<{ block_id?: string; type?: string }> } | undefined,
  ): Promise<void> {
    // Strip any prior feedback-related blocks (actions + any lingering ack),
    // so concurrent clicks or re-entries don't stack blocks.
    const cleanedBlocks = (original?.blocks ?? []).filter(
      (b) => b.block_id !== FEEDBACK_BLOCK_ID && b.block_id !== FEEDBACK_ACK_BLOCK_ID,
    );
    // Note: `text` is intentionally omitted from chat.update — Slack keeps the
    // original notification fallback. Echoing it back tripped `msg_too_long`
    // for very long agent replies, since slack-formatter sets text=content.

    try {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        blocks: [...cleanedBlocks, buildFeedbackAckBlock()],
      });
    } catch (error) {
      logger.warn(
        '[SlackAdapter] Failed to replace feedback buttons with ack: %s',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    // Schedule the ack block to auto-remove so the message settles back to a
    // clean state. Best-effort: failures are logged and swallowed. unref() so
    // a pending timer doesn't keep the process alive on shutdown.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            blocks: cleanedBlocks,
          });
        } catch (error) {
          logger.warn(
            '[SlackAdapter] Failed to clear feedback ack block: %s',
            error instanceof Error ? error.message : String(error),
          );
        }
      })();
    }, FEEDBACK_ACK_LINGER_MS);
    timer.unref?.();
  }

  /**
   * Set up channel-specific event handlers
   */
  private setupChannelEventHandlers(app: App, connectionId: string, botUserId: string): void {
    // Handle bot joining a channel
    app.event('member_joined_channel', async ({ event, client }) => {
      const evt = event as { user: string; channel: string };

      // Only handle when the bot itself joins
      if (evt.user !== botUserId) {
        return;
      }

      logger.info('Bot joined channel %s', evt.channel);

      // Check if channel already has a linked agent
      const existingMapping = await slackMappingService.findByChannelId(evt.channel);
      if (existingMapping) {
        // Already linked, no action needed
        logger.info('Channel %s already linked to an agent', evt.channel);
        return;
      }

      // Post welcome message asking for verification code
      try {
        await client.chat.postMessage({
          channel: evt.channel,
          text: "👋 Hi! I've been added to this channel.\n\nTo activate me, please enter the verification code from your agent settings.\nYou can find this in *Settings → Channels → Link to Channel*.",
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to post welcome message to channel %s: %s', evt.channel, message);
      }
    });

    // Handle bot being removed from a channel
    app.event('member_left_channel', async ({ event }) => {
      const evt = event as { user: string; channel: string };

      // Only handle when the bot itself leaves
      if (evt.user !== botUserId) {
        return;
      }

      logger.info('Bot left channel %s', evt.channel);

      // Remove channel mapping if exists
      try {
        await slackMappingService.deleteChannelMapping(evt.channel);
        logger.info('Removed channel mapping for %s', evt.channel);
      } catch {
        // Mapping might not exist, that's fine
      }
    });
  }

  /**
   * Check if this looks like a verification code
   */
  private isVerificationCode(text: string): boolean {
    return /^[A-Fa-f0-9]{6}$/.test(text?.trim() || '');
  }

  /**
   * Verify a DM link code directly (local Prisma — same logic as management route)
   */
  private async verifyDmLinkCode(
    code: string,
    slackUserId: string,
    dmChannelId: string
  ): Promise<{ success: boolean; message: string }> {
    const upperCode = code.toUpperCase();
    const verification = await prisma.slackVerificationCode.findUnique({
      where: { code_type: { code: upperCode, type: 'DM' } },
    });

    if (!verification) {
      return { success: false, message: 'That code is not valid. Generate a new code in Prism Agent, under Settings → Channels.' };
    }

    if (new Date() > verification.expiresAt) {
      await prisma.slackVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'DM' } },
      }).catch(() => {});
      return { success: false, message: 'That code has expired. Generate a new code in Prism Agent, under Settings → Channels.' };
    }

    // Check if this Slack user is already linked to someone
    const existingSlackLink = await prisma.slackMapping.findFirst({
      where: {
        connectionId: verification.connectionId,
        slackUserId,
      },
    });

    if (existingSlackLink) {
      if (existingSlackLink.lensUserId === verification.lensUserId) {
        return { success: false, message: 'Your Slack account is already linked to another agent. Unlink it first from that agent\'s settings.' };
      }
      return { success: false, message: 'This Slack account is already linked to another Prism Agent user.' };
    }

    // Atomic: create mapping + consume code
    await prisma.$transaction([
      prisma.slackMapping.create({
        data: {
          connectionId: verification.connectionId,
          agentId: verification.agentId,
          slackUserId,
          lensUserId: verification.lensUserId,
          dmChannelId,
        },
      }),
      prisma.slackVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'DM' } },
      }),
    ]);

    logger.info('Slack account linked via code: %s -> %s', slackUserId, verification.lensUserId);

    return { success: true, message: `Your Slack account is now linked. You can chat with ${verification.agentName || 'your agent'} here.` };
  }

  /**
   * Verify and link a channel to an agent
   */
  private async verifyAndLinkChannel(
    code: string,
    channelId: string,
    slackUserId: string,
    teamId?: string
  ): Promise<{ success: boolean; message: string; agentName?: string }> {
    try {
      // Fetch channel name if we have teamId
      let channelName: string | undefined;
      if (teamId) {
        channelName = (await this.getChannelName(channelId, teamId)) || undefined;
      }

      // Verify directly using local Prisma (same logic as management route)
      const result = await this.verifyChannelLinkCodeLocal(code, channelId, channelName);

      if (result.success) {
        return {
          success: true,
          message: result.message,
          agentName: result.agentName,
        };
      }

      return { success: false, message: result.message || 'Invalid or expired code' };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return { success: false, message: `Verification failed: ${errMsg}` };
    }
  }

  /**
   * Verify a channel link code directly (local Prisma)
   */
  private async verifyChannelLinkCodeLocal(
    code: string,
    channelId: string,
    channelName?: string
  ): Promise<{ success: boolean; message: string; agentName?: string }> {
    const upperCode = code.toUpperCase();
    const verification = await prisma.slackVerificationCode.findUnique({
      where: { code_type: { code: upperCode, type: 'CHANNEL' } },
    });

    if (!verification) {
      return { success: false, message: 'That code is not valid. Generate a new code in Prism Agent, under Settings → Channels.' };
    }

    if (new Date() > verification.expiresAt) {
      await prisma.slackVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'CHANNEL' } },
      }).catch(() => {});
      return { success: false, message: 'That code has expired. Generate a new code in Prism Agent, under Settings → Channels.' };
    }

    // Check if this channel is already linked
    const existingChannelLink = await prisma.slackMapping.findUnique({
      where: { slackChannelId: channelId },
    });

    if (existingChannelLink) {
      return { success: false, message: 'This channel is already linked to an agent.' };
    }

    // Atomic: create channel mapping + consume code
    await prisma.$transaction([
      prisma.slackMapping.create({
        data: {
          connectionId: verification.connectionId,
          agentId: verification.agentId,
          slackChannelId: channelId,
          slackChannelName: channelName || channelId,
          lensUserId: verification.lensUserId,
          slackUserId: null,
          dmChannelId: null,
        },
      }),
      prisma.slackVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'CHANNEL' } },
      }),
    ]);

    logger.info('Slack channel linked via code: %s -> %s\'s agent', channelId, verification.lensUserId);

    return {
      success: true,
      message: 'Your Slack channel is now linked. Mention me anytime you need help!',
      agentName: verification.agentName ?? undefined,
    };
  }

  /**
   * Check if bot is participating in a thread (heuristic pass)
   *
   * Judges `arriving`, the message this call was triggered by, and returns a
   * ThreadParticipation plus the thread messages so the caller can forward them
   * to the LLM classifier without re-fetching. The returned transcript ends on
   * `arriving`, which is the message the caller reacts to or answers.
   */
  private async isBotInThread(
    channelId: string,
    threadTs: string,
    teamId: string,
    arriving: Required<GateMessage>,
  ): Promise<{ result: ThreadParticipation; messages: GateMessage[] }> {
    const slackApp = this.apps.get(teamId);
    if (!slackApp) return { result: { action: 'ignore' }, messages: [] };

    try {
      const reply = await slackApp.app.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 100,
      });

      // `conversations.replies` is eventually consistent, so the read may lack
      // `arriving` or already hold a message posted after it. Both cut to a
      // transcript ending on `arriving`.
      const fetched = (reply.messages || []) as GateMessage[];
      const at = fetched.findIndex((m) => m.ts === arriving.ts);
      const messages = at === -1 ? [...fetched, arriving] : fetched.slice(0, at + 1);

      let lastBotIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].user === slackApp.botUserId) {
          lastBotIndex = i;
          break;
        }
      }

      // Bot never posted in this thread
      if (lastBotIndex === -1) return { result: { action: 'ignore' }, messages };

      // The arriving message tags somebody other than the bot, so it is
      // addressed to that person. Only this message is read: a tag earlier in
      // the thread is addressed to somebody else and leaves a later message
      // aimed at the bot answerable.
      for (const match of arriving.text.matchAll(/<@([A-Z0-9]+)>/g)) {
        if (match[1] !== slackApp.botUserId) {
          return { result: { action: 'react' }, messages };
        }
      }

      // Bot is participating and the message is not addressed elsewhere — pass to LLM
      return { result: { action: 'respond' }, messages };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('isBotInThread failed for channel %s, thread %s: %s', channelId, threadTs, errMsg);
      return { result: { action: 'ignore' }, messages: [] };
    }
  }

  /**
   * Second pass after the heuristic: the shared classifier decides whether the
   * bot responds to or ignores the last message of `messages`.
   */
  private classifyThreadMessage(
    messages: GateMessage[],
    botUserId: string,
    agentId: string,
  ): Promise<ThreadAction> {
    return threadReplyClassifierService.classify({
      platform: { channel: this.name, name: 'Slack' },
      agentId,
      lines: messages.map((m) => ({
        fromBot: m.user === botUserId,
        author: m.user ?? 'unknown',
        text: m.text ?? '',
      })),
    });
  }

  /**
   * Add a reaction emoji to a Slack message (best-effort, awaited).
   *
   * Errors are caught and logged; failures do not propagate to the caller.
   */
  private async addReaction(
    channelId: string,
    messageTs: string,
    teamId: string,
    emoji: string,
  ): Promise<void> {
    const slackApp = this.apps.get(teamId);
    if (!slackApp) return;

    try {
      await slackApp.app.client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: emoji,
      });
    } catch (error) {
      logger.warn('Failed to add reaction %s: %s', emoji, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Remove a reaction emoji from a Slack message (best-effort, awaited).
   *
   * `no_reaction` is the expected error when the earlier add failed —
   * swallowed like every other failure here.
   */
  private async removeReaction(
    channelId: string,
    messageTs: string,
    teamId: string,
    emoji: string,
  ): Promise<void> {
    const slackApp = this.apps.get(teamId);
    if (!slackApp) return;

    try {
      await slackApp.app.client.reactions.remove({
        channel: channelId,
        timestamp: messageTs,
        name: emoji,
      });
    } catch (error) {
      logger.warn('Failed to remove reaction %s: %s', emoji, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Assistant thread status ("is thinking…" next to the bot name).
   *
   * Rejects when the status cannot be set — routine when the app lacks the
   * `assistant:write` scope, is not configured as a Slack AI app, or the
   * target thread does not render statuses. The working indicator catches
   * the rejection, logs it at debug, and falls back to the eyes reaction.
   */
  private async setAssistantStatus(
    teamId: string,
    channelId: string,
    threadTs: string,
    status: string,
  ): Promise<void> {
    const slackApp = this.apps.get(teamId);
    if (!slackApp) throw new Error(`no Slack app for team ${teamId}`);

    // `loading_messages` (optional, ≤10 strings) would replace the rotating
    // shimmer phrases Slack displays while the status is active. We omit it
    // deliberately, so Slack rotates its own default list ("Gathering
    // information…", "Reviewing findings…", …).
    await slackApp.app.client.assistant.threads.setStatus({
      channel_id: channelId,
      thread_ts: threadTs,
      status,
    });
  }

  /**
   * Get user info from Slack
   */
  private async getUserInfo(slackUserId: string, teamId: string): Promise<{ real_name?: string; name?: string } | null> {
    const slackApp = this.apps.get(teamId);
    if (!slackApp) return null;

    try {
      const result = await slackApp.app.client.users.info({ user: slackUserId });
      return result.user as { real_name?: string; name?: string } | undefined ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Download user-uploaded Slack files into our DB and return the new
   * attachment ids (to link to the user message via `chat({ attachmentIds })`).
   *
   * Enforces the 10 MB cap (from Slack's reported size, then again after
   * download), dedups on Slack file id (events are at-least-once), and skips
   * anything that fails to download. `externalTs` records the carrying
   * message's ts so the live-read Slack channel provider can re-associate the
   * file on later turns; `threadId` scopes that lookup.
   */
  private async downloadSlackFiles(
    files: SlackFileMeta[],
    ctx: { externalTs?: string; threadId?: string },
  ): Promise<SlackFileDownloadResult> {
    const attachmentIds: string[] = [];
    const failures: SlackFileFailure[] = [];
    if (files.length === 0) return { attachmentIds, failures };

    // Cap before downloading so we never pull bytes for files that would be
    // dropped at link time (linkToMessage enforces the same per-message cap).
    let toProcess = files;
    if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      toProcess = files.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
      failures.push({
        filename: `${files.length - MAX_ATTACHMENTS_PER_MESSAGE} more file(s)`,
        reason: `only the first ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message are kept`,
      });
    }

    const connection = await getSlackConnection();
    const botToken = connection?.botToken;
    if (!botToken) {
      logger.warn('[SlackAdapter] no bot token available; cannot download %d file(s)', toProcess.length);
      for (const file of toProcess) {
        failures.push({ filename: file.name || 'file', reason: 'no Slack bot token is available to download it' });
      }
      return { attachmentIds, failures };
    }

    for (const file of toProcess) {
      const filename = file.name || 'file';
      try {
        if (typeof file.size === 'number' && file.size > MAX_FILE_SIZE_BYTES) {
          logger.warn('[SlackAdapter] skipping oversized file %s (%d bytes)', filename, file.size);
          failures.push({ filename, reason: `it exceeds the ${MAX_FILE_SIZE_MB} MB limit` });
          continue;
        }

        if (await attachmentService.existsByExternalFileId(file.id)) {
          logger.info('[SlackAdapter] file %s already stored; skipping', file.id);
          continue;
        }

        const url = file.url_private_download || file.url_private;
        if (!url) {
          logger.warn('[SlackAdapter] file %s has no download URL', file.id);
          failures.push({ filename, reason: 'Slack returned no download URL for it' });
          continue;
        }

        const buffer = await this.fetchSlackFile(url, botToken);
        if (buffer.byteLength === 0) {
          logger.warn('[SlackAdapter] file %s downloaded empty; skipping', file.id);
          failures.push({ filename, reason: 'it downloaded as an empty file' });
          continue;
        }
        if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
          logger.warn('[SlackAdapter] file %s exceeds cap after download; skipping', file.id);
          failures.push({ filename, reason: `it exceeds the ${MAX_FILE_SIZE_MB} MB limit` });
          continue;
        }

        const mediaType = detectMediaType(buffer, filename, file.mimetype);
        const row = await attachmentService.createOnce({
          filename,
          mediaType,
          sizeBytes: buffer.byteLength,
          data: buffer,
          category: classifyMediaType(mediaType),
          source: 'slack',
          externalFileId: file.id,
          externalTs: ctx.externalTs,
          threadId: ctx.threadId,
        });
        // null = a concurrent redelivery already stored this file id.
        if (row) {
          attachmentIds.push(row.id);
        } else {
          logger.info('[SlackAdapter] file %s already stored (concurrent delivery); skipping', file.id);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error({ err, fileId: file.id }, '[SlackAdapter] failed to download Slack file');
        failures.push({ filename, reason });
      }
    }
    return { attachmentIds, failures };
  }

  /**
   * Render download failures as a single runtime notice, delivered via the
   * system prompt (InvokeRequest.runtimeNotices). Worded to counter the failure
   * modes seen in testing — the agent claiming no file was attached, and asking
   * for a file path / hunting on disk — since user-embedded notes were ignored.
   */
  private buildAttachmentFailureNote(failures: SlackFileFailure[]): string {
    const list = failures.map((f) => `"${f.filename}": ${f.reason}`).join('; ');
    const many = failures.length > 1;
    const their = many ? 'their' : 'its';
    const theirs = many ? 'their attached files' : 'their attached file';
    const were = many ? 'they were chat attachments' : 'it was a chat attachment';
    return (
      `The user attached ${many ? 'files' : 'a file'} to this message that could not be downloaded from ` +
      `Slack, so you do NOT have ${their} contents: ${list}. In your reply, tell the user you couldn't ` +
      `read ${theirs} and give the reason; if it's an access/permission error, mention the Slack app ` +
      `likely needs the \`files:read\` scope. Do not say no file was attached, and do not ask for a file ` +
      `path or look on disk — ${were} that failed to download, not a local file.`
    );
  }

  /**
   * Fetch a single Slack file's bytes using bot-token Bearer auth. Slack
   * returns an HTML login page (HTTP 200) — not a 401 — when the token can't
   * read the file, so a non-binary content type is treated as an auth failure.
   */
  private async fetchSlackFile(url: string, botToken: string): Promise<Buffer> {
    // Loose shape: `dispatcher` is an undici extension to fetch's init that the
    // two bundled Dispatcher type copies (undici vs undici-types) disagree on.
    const init: Record<string, unknown> = {
      headers: { Authorization: `Bearer ${botToken}` },
    };
    const dispatcher = await getProxyDispatcher();
    if (dispatcher) init.dispatcher = dispatcher;

    const res = await fetch(url, init as RequestInit);
    if (!res.ok) {
      throw new Error(`Slack returned HTTP ${res.status} for the file download`);
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      // Slack serves an HTML login/redirect page (HTTP 200) — not a 401 — when
      // the token can't read the file. Almost always a missing scope.
      throw new Error('Slack denied access to the file (the bot likely lacks the files:read scope, or the file is not shared with it)');
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Build the sender-tagged form of an inbound message — `<@U:Name>: text`.
   *
   * The agent's conversation history then carries the speaker's canonical
   * Slack mention token, which the agent can copy verbatim into a reply
   * (where `rewriteOutboundMentions()` strips the embedded name and Slack
   * fires a real notification).
   *
   * Falls back to the bare message when the sender's display name is unknown.
   */
  private buildSenderTaggedContent(
    slackUserId: string,
    senderName: string | undefined,
    text: string,
  ): string {
    if (!senderName) return text;
    const sanitized = senderName.replace(/[<>:\x00-\x1f]/g, '').trim();
    const tag = sanitized ? `<@${slackUserId}:${sanitized}>` : `<@${slackUserId}>`;
    return `${tag}: ${text}`;
  }

  /**
   * Resolve user mentions on inbound Slack text.
   *
   * Rewrites each bare `<@USERID>` token to the combined form
   * `<@USERID:displayName>` so downstream consumers (the agent, the stored
   * message history) see both the canonical ID and a human-readable name.
   * `rewriteOutboundMentions()` is the inverse and is applied before
   * delivering agent output back to Slack.
   *
   * Idempotent over already-resolved `<@USERID:Name>` tokens — the regex
   * only matches the bare form (no colon).
   *
   * Also converts broadcast mentions (`<!channel>`, `<!here>`, `<!everyone>`)
   * to readable plain-text form.
   */
  private async resolveMentions(text: string, teamId: string): Promise<string> {
    // Convert broadcast mentions first
    let resolved = text
      .replace(/<!channel>/g, '@channel')
      .replace(/<!here>/g, '@here')
      .replace(/<!everyone>/g, '@everyone');

    // Match only the bare <@ID> form so this function is idempotent over
    // already-resolved <@ID:Name> tokens.
    const mentionPattern = /<@([A-Z0-9]+)>/g;
    const matches = [...resolved.matchAll(mentionPattern)];
    if (matches.length === 0) return resolved;

    const uniqueUserIds = [...new Set(matches.map((m) => m[1]))];
    const userInfoMap = new Map<string, string>();
    await Promise.all(
      uniqueUserIds.map(async (uid) => {
        const userInfo = await this.getUserInfo(uid, teamId);
        userInfoMap.set(uid, userInfo?.real_name || userInfo?.name || uid);
      })
    );
    for (const match of matches) {
      const rawName = userInfoMap.get(match[1]) || match[1];
      // Sanitize: strip `>`, `:`, and control chars so the combined marker
      // stays unambiguous for the inverse regex.
      const sanitizedName = rawName.replace(/[<>:\x00-\x1f]/g, '').trim() || match[1];
      resolved = resolved.replace(match[0], `<@${match[1]}:${sanitizedName}>`);
    }
    return resolved;
  }

  /**
   * Prepare agent output for a Slack `chat.postMessage`.
   *
   * Pairs {@link rewriteOutboundMentions} with {@link formatSlackMessage} so
   * every delivery path normalizes `<@USERID:Name>` tokens back to Slack's
   * native mention syntax before Block Kit rendering. Callers must route
   * outbound text through this helper rather than calling the two steps
   * directly — otherwise mentions silently degrade to plain text.
   */
  private async prepareOutboundMessage(
    content: string,
    teamId: string,
    triggeredBy: string | undefined,
    toolCalls: Array<{ tool: string }> | undefined,
    options: FormatSlackMessageOptions | undefined,
  ): Promise<{ text: string; blocks: SlackBlock[] }> {
    const outboundText = await this.rewriteOutboundMentions(content, teamId);
    return formatSlackMessage(outboundText, triggeredBy, toolCalls, options);
  }

  /**
   * Inverse of {@link resolveMentions} for outbound delivery.
   *
   * Converts each `<@USERID:displayName>` (or bare `<@USERID>`) the agent
   * emitted back into Slack's native `<@USERID>` mention syntax, which Slack
   * renders as a clickable user pill and uses to fire a real notification.
   *
   * Best-effort validation: any USERID that does not resolve via
   * {@link getUserInfo} is treated as hallucinated or stale. With an
   * embedded display name we downgrade to plain `@displayName`; without
   * one, the unknown bare token is dropped.
   */
  private async rewriteOutboundMentions(text: string, teamId: string): Promise<string> {
    const mentionPattern = /<@([A-Z0-9]+)(?::([^>]+))?>/g;
    const matches = [...text.matchAll(mentionPattern)];
    if (matches.length === 0) return text;

    const uniqueUserIds = [...new Set(matches.map((m) => m[1]))];
    const validity = new Map<string, boolean>();
    await Promise.all(
      uniqueUserIds.map(async (uid) => {
        const userInfo = await this.getUserInfo(uid, teamId);
        validity.set(uid, userInfo !== null);
      })
    );

    let resolved = text;
    for (const match of matches) {
      const [token, uid, embeddedName] = match;
      if (validity.get(uid)) {
        resolved = resolved.replace(token, `<@${uid}>`);
      } else if (embeddedName) {
        logger.info('Downgrading unknown Slack mention %s to plain text', uid);
        resolved = resolved.replace(token, `@${embeddedName}`);
      } else {
        logger.info('Dropping unknown bare Slack mention %s', uid);
        resolved = resolved.replace(token, '');
      }
    }
    return resolved;
  }

  /**
   * Notify with throttle awareness.
   *
   * Attempts an atomic claim on the trigger. If claimed, notifies immediately.
   * If throttled, schedules a deferred notification via setTimeout.
   */
  private async throttledNotify(agentId: string): Promise<void> {
    // Direct local call to the trigger service (no HTTP)
    const result = await slackHeartbeatTriggerService.tryClaimTrigger();

    if (result.claimed) {
      try {
        // Direct local call to heartbeat service
        heartbeatService.triggerFrom(slackMessageQueueService);
      } catch (error) {
        logger.error('[ThrottledNotify] Failed to trigger heartbeat for agent %s: %s', agentId, error instanceof Error ? error.message : String(error));
      }
    } else if (result.remainingSeconds && result.remainingSeconds > 0) {
      await getSlackHeartbeatThrottleQueue().scheduleDeferred(agentId, result.remainingSeconds);
    }
  }

  /**
   * Add a participant to a conversation thread
   */
  private async addParticipant(threadId: string, externalUserId: string, displayName: string): Promise<void> {
    try {
      await prisma.conversationParticipant.upsert({
        where: {
          threadId_externalUserId_channel: {
            threadId,
            externalUserId,
            channel: 'slack',
          },
        },
        update: {
          displayName,
        },
        create: {
          threadId,
          externalUserId,
          displayName,
          channel: 'slack',
        },
      });
    } catch (error: unknown) {
      // Log but don't fail if participant tracking fails
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to add participant %s: %s', externalUserId, message);
    }
  }

  /**
   * Rebuild user connection cache from database
   */
  private async rebuildUserCache(): Promise<void> {
    this.userConnectionCache.clear();

    const mappings = await slackMappingService.getActiveUserMappingsWithDmChannel();

    for (const mapping of mappings) {
      if (!mapping.lensUserId) continue;

      let teams = this.userConnectionCache.get(mapping.lensUserId);
      if (!teams) {
        teams = new Set();
        this.userConnectionCache.set(mapping.lensUserId, teams);
      }
      teams.add(mapping.connection.teamId);
    }

    logger.info('Slack user cache built: %d user(s)', this.userConnectionCache.size);
  }

  /**
   * Disconnect and stop the Bolt app for a connection, and delete all rows
   * that reference this connectionId (SlackMapping, SlackVerificationCode,
   * SlackHeartbeatTrigger). The connection itself is env-sourced — there's
   * no separate connection row to deactivate.
   */
  async disconnectAndDeactivate(connectionId: string): Promise<void> {
    const connection = await getSlackConnection();
    if (!connection) {
      throw new Error('Connection not found');
    }

    // Stop the Bolt app first so no new messages arrive during cleanup.
    const slackApp = this.apps.get(connection.teamId);
    try {
      if (slackApp?.isSocketMode) {
        await slackApp.app.stop();
      }
    } catch (error) {
      logger.warn(
        { err: error, teamId: connection.teamId, teamName: connection.teamName, connectionId },
        'Failed to stop Slack app during disconnect; continuing with cleanup',
      );
    } finally {
      this.apps.delete(connection.teamId);
    }

    // Remove all rows that reference this connectionId in a single
    // transaction so a failure in any one delete rolls back the others —
    // otherwise a partial cleanup would leave the caller with no clean way
    // to retry.
    const { mappings, codes, triggers } = await prisma.$transaction(async (tx) => {
      const mappingCount = await slackMappingService.deleteByConnectionId(connectionId, tx);
      const codeResult = await tx.slackVerificationCode.deleteMany({ where: { connectionId } });
      const triggerCount = await slackHeartbeatTriggerService.deleteByConnectionId(
        connectionId,
        tx,
      );
      return { mappings: mappingCount, codes: codeResult.count, triggers: triggerCount };
    });

    // Rebuild cache after mappings are deleted so stale entries are not
    // re-populated.
    await this.rebuildUserCache();

    logger.info(
      { teamName: connection.teamName, mappings, codes, triggers },
      'Disconnected Slack connection and removed mappings',
    );

    trackEvent('slack connection removed', null, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'slack.connection.id': connectionId,
      'slack.mappings_removed': String(mappings),
    });
  }

  /**
   * Create or update a user mapping
   *
   * Called when a Slack user links their account.
   */
  async linkSlackUser(
    connectionId: string,
    slackUserId: string,
    lensUserId: string,
    agentId: string,
    dmChannelId?: string
  ): Promise<void> {
    await slackMappingService.upsertUserMapping(connectionId, slackUserId, lensUserId, agentId, dmChannelId);

    // Rebuild cache
    await this.rebuildUserCache();

    logger.info('Linked Slack user %s to Lens user %s', slackUserId, lensUserId);
    trackEvent('slack user linked', lensUserId, {
      'agent.id': agentId,
      'slack.user.id': slackUserId,
    });
  }

  /**
   * Get channel name from Slack API
   */
  async getChannelName(channelId: string, teamId: string): Promise<string | null> {
    const slackApp = this.apps.get(teamId);
    if (!slackApp) return null;

    try {
      const result = await slackApp.app.client.conversations.info({ channel: channelId });
      const channel = result.channel as { name?: string } | undefined;
      return channel?.name ?? null;
    } catch {
      return null;
    }
  }
}

// Export singleton instance
export const slackAdapterService = new SlackAdapterService();
