/**
 * Teams Adapter Service (Agent-Runtime)
 *
 * Implements ChannelAdapter for Microsoft Teams message delivery using the
 * Bot Framework SDK (`botbuilder`) with a CloudAdapter — the Teams analogue
 * of `slack-adapter.service.ts`.
 *
 * Key differences from Slack, dictated by the platform:
 * - No Socket Mode: Teams pushes activities to an HTTPS endpoint
 *   (`POST /api/teams/messages`, mounted in server.ts). The endpoint must
 *   ack within ~15s, so message processing is detached from the turn and
 *   all outbound sends are proactive (`continueConversationAsync`) using
 *   conversation references captured from inbound activities.
 * - Receiving non-mentioned channel messages (passive learning, heartbeat
 *   trigger channels) requires the Teams app manifest to grant the RSC
 *   permission `ChannelMessage.Read.Group`. Without it, Teams only delivers
 *   messages that @mention the bot.
 * - Bots cannot read channel history, so the thread-participation check and
 *   the LLM thread classifier run over locally stored messages
 *   (ThreadSource.TEAMS threads use the database provider).
 * - Bots cannot add reactions, so a "react" classification falls through to
 *   passive learning without a visible acknowledgement.
 * - Feedback 👍/👎 is an Adaptive Card (Action.Submit) instead of Block Kit.
 */

import {
  Activity,
  ActivityTypes,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationServiceClientCredentialFactory,
  ConversationReference,
  TurnContext,
} from 'botbuilder';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { ConversationMessage, Prisma } from '@prisma/client';
import { generateObject } from 'ai';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { logger } from '../logger';
import { ChannelAdapter } from './channel-adapter.interface';
import { teamsMappingService } from './teams-mapping.service';
import {
  formatTeamsMessage,
  buildFeedbackAckCard,
  FEEDBACK_ACTION_UP,
  FEEDBACK_RATING_UP,
  FEEDBACK_RATING_DOWN,
  FeedbackRating,
  FormatTeamsMessageOptions,
  FormattedTeamsMessage,
  TeamsFeedbackSubmitValue,
} from '../utils/teams-formatter';
import { trackEvent } from '../lib/telemetry';
import { getClassificationModel } from '../lib/classification';
import { teamsMessageQueueService } from './teams-message-queue.service';
import { teamsHeartbeatTriggerService } from './teams-heartbeat-trigger.service';
import { heartbeatService } from './heartbeat.service';
import { conversationService } from './conversation.service';
import { conversationEngineService } from './conversation-engine.service';
import { getTeamsHeartbeatThrottleQueue } from '../queues/teams-heartbeat-throttle-queue';
import { channelLearningQueue } from '../queues/channel-learning.queue';
import { getActiveTeamsConnections, getTeamsConnection, TeamsConnectionRecord } from '../lib/teams-source';

// ============================================================================
// Tunables
// ============================================================================

/**
 * Duration (ms) to keep the inline "Thanks for the feedback!" ack card
 * visible before auto-removing it via a second updateActivity. Mirrors the
 * Slack adapter's linger.
 */
export const FEEDBACK_ACK_LINGER_MS = 3000;

// ============================================================================
// Types
// ============================================================================

type ThreadAction =
  | { action: 'respond' }
  | { action: 'react'; emoji: string }
  | { action: 'ignore' };

const threadClassificationSchema = z.object({
  action: z.enum(['respond', 'react', 'ignore']),
  emoji: z.string().optional(),
});

interface MentionEntity {
  type: string;
  text?: string;
  mentioned?: { id?: string; name?: string };
}

// Combined mention marker used in stored conversation history:
//   <@29:abc...|Display Name>
// Teams user ids contain ':' so '|' separates id from name (Slack uses ':').
const TEAMS_MENTION_TOKEN = /<@([^|>]+?)(?:\|([^>]+))?>/g;
const TEAMS_USER_ID_PATTERN = /^(?:29|28):[A-Za-z0-9_\-+/=.]+$/;

// ============================================================================
// Teams Adapter Service
// ============================================================================

class TeamsAdapterService implements ChannelAdapter {
  readonly name = 'teams';

  private adapter: CloudAdapter | null = null;
  private connection: TeamsConnectionRecord | null = null;

  /**
   * List metadata for the connected Teams bot registration. Used by the
   * Web UI to display connection info on the Channels page (the Teams
   * analogue of `listConnectedWorkspaces`).
   */
  listConnections(): Array<{ appId: string; tenantId: string | null; botId: string }> {
    if (!this.connection) return [];
    return [{
      appId: this.connection.appId,
      tenantId: this.connection.tenantId,
      botId: this.connection.botId,
    }];
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Initialize the Teams adapter: validate env credentials (via teams-config)
   * and build the CloudAdapter that authenticates inbound activities and
   * sends outbound ones.
   */
  async initialize(): Promise<void> {
    logger.info('Initializing Teams adapter...');

    try {
      const connections = await getActiveTeamsConnections();
      if (connections.length === 0) {
        logger.info('No active Teams connection; adapter idle');
        return;
      }

      const connection = connections[0];

      const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
        MicrosoftAppId: connection.appId,
        MicrosoftAppPassword: connection.appPassword,
        MicrosoftAppType: connection.tenantId ? 'SingleTenant' : 'MultiTenant',
        ...(connection.tenantId && { MicrosoftAppTenantId: connection.tenantId }),
      });
      const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({}, credentialsFactory);
      const adapter = new CloudAdapter(botFrameworkAuth);

      adapter.onTurnError = async (_context, error) => {
        logger.error('Teams adapter turn error: %s', error instanceof Error ? error.message : String(error));
      };

      this.adapter = adapter;
      this.connection = connection;

      logger.info('Teams adapter initialized: app %s', connection.appId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to initialize Teams adapter: %s', message);
    }
  }

  /**
   * Shutdown Teams adapter. The CloudAdapter holds no persistent
   * connections (inbound is plain HTTPS), so this just drops references.
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Teams adapter...');
    this.adapter = null;
    this.connection = null;
  }

  /**
   * Express handler for `POST /api/teams/messages`. The CloudAdapter
   * validates the Bot Framework JWT and invokes our turn handler.
   */
  async processIncoming(req: ExpressRequest, res: ExpressResponse): Promise<void> {
    if (!this.adapter) {
      res.status(503).json({ error: 'Teams adapter not configured' });
      return;
    }
    // CloudAdapter's Request/Response interfaces are structurally
    // compatible with Express 5's req/res (parsed JSON body honored).
    await this.adapter.process(req, res, (context) => this.handleTurn(context));
  }

  /**
   * Disconnect and delete all rows that reference this connectionId
   * (TeamsMapping, TeamsVerificationCode, TeamsHeartbeatTrigger). The
   * connection itself is env-sourced — there's no connection row.
   */
  async disconnectAndDeactivate(connectionId: string): Promise<void> {
    const connection = await getTeamsConnection();
    if (!connection) {
      throw new Error('Connection not found');
    }

    this.adapter = null;
    this.connection = null;

    const { mappings, codes, triggers } = await prisma.$transaction(async (tx) => {
      const mappingCount = await teamsMappingService.deleteByConnectionId(connectionId, tx);
      const codeResult = await tx.teamsVerificationCode.deleteMany({ where: { connectionId } });
      const triggerCount = await teamsHeartbeatTriggerService.deleteByConnectionId(connectionId, tx);
      return { mappings: mappingCount, codes: codeResult.count, triggers: triggerCount };
    });

    logger.info(
      { appId: connection.appId, mappings, codes, triggers },
      'Disconnected Teams connection and removed mappings',
    );
  }

  // ==========================================================================
  // Delivery (ChannelAdapter contract)
  // ==========================================================================

  /**
   * Deliver a message to the user via Teams personal chat or channel.
   *
   * If channelContext is provided and it's a Teams channel, delivers to that
   * conversation. Otherwise, delivers to all Teams mappings for the user
   * (personal chats via stored conversation references, channels via
   * top-level posts) — same broadcast semantics as the Slack adapter.
   */
  async deliver(
    userId: string,
    message: ConversationMessage,
    channelContext?: { channel: string; channelId?: string; threadTs?: string; threadId: string; includeFeedback?: boolean }
  ): Promise<void> {
    const includeFeedback = channelContext?.includeFeedback === true;

    if (channelContext?.channel === 'teams' && channelContext.channelId) {
      await this.deliverToChannel(
        channelContext.channelId,
        message.content,
        channelContext.threadId,
        channelContext.threadTs,
        (message.toolCalls as Array<{ tool: string }>) ?? undefined,
        message.id,
        includeFeedback,
      );
      return;
    }

    // Look up agentId from the message's thread to scope delivery
    const thread = await prisma.conversationThread.findUnique({
      where: { id: message.threadId },
      select: { agentId: true },
    });

    const mappings = await prisma.teamsMapping.findMany({
      where: {
        lensUserId: userId,
        ...(thread?.agentId && { agentId: thread.agentId }),
      },
    });

    for (const mapping of mappings) {
      // Personal chat (personal mode) — proactive send via stored reference
      if (mapping.teamsUserId && mapping.conversationReference) {
        try {
          const reference = mapping.conversationReference as unknown as Partial<ConversationReference>;
          const chunks = this.prepareOutboundMessage(
            message.content,
            message.triggeredBy || undefined,
            (message.toolCalls as Array<{ tool: string }>) ?? undefined,
            includeFeedback ? { feedbackMessageId: message.id } : undefined,
          );
          const ids = await this.sendToReference(reference, chunks);

          const lastId = ids[ids.length - 1];
          if (lastId) {
            await conversationService.setExternalMessageId(message.id, lastId);
          }

          logger.info('Delivered message to Teams personal chat for user %s', userId);
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          logger.error('Teams personal delivery failed for user %s: %s', userId, errMsg);
        }
      }

      // Teams channel (team mode) — new top-level post
      if (mapping.teamsChannelId) {
        await this.deliverToChannel(
          mapping.teamsChannelId,
          message.content,
          message.threadId,
          undefined,
          (message.toolCalls as Array<{ tool: string }>) ?? undefined,
          message.id,
          includeFeedback,
        );
      }
    }
  }

  /**
   * Deliver a message to a Teams channel (team mode).
   *
   * `conversationId` (when set) targets an existing thread — the Teams
   * conversation id encodes the thread root via `;messageid=`. When unset,
   * the message is posted as a new top-level message in the channel.
   */
  async deliverToChannel(
    channelId: string,
    content: string,
    threadId: string,
    conversationId?: string,
    toolCalls?: Array<{ tool: string }>,
    messageId?: string,
    includeFeedback: boolean = false,
  ): Promise<void> {
    const mapping = await teamsMappingService.findByChannelId(channelId);

    if (!mapping) {
      logger.warn('No channel mapping found for Teams channel %s', channelId);
      return;
    }

    if (!mapping.serviceUrl) {
      logger.warn('Teams channel mapping %s has no serviceUrl — cannot deliver', channelId);
      return;
    }

    try {
      const chunks = this.prepareOutboundMessage(
        content,
        undefined,
        toolCalls,
        includeFeedback && messageId ? { feedbackMessageId: messageId } : undefined,
      );

      const reference = this.buildConversationReference(
        mapping.serviceUrl,
        conversationId || channelId,
        mapping.tenantId,
      );
      const ids = await this.sendToReference(reference, chunks);

      // Only set external ID when responding in an existing Teams thread.
      // When posting a new top-level message (e.g. heartbeat/cron broadcast),
      // skip setExternalId to avoid corrupting the webchat active thread.
      if (conversationId) {
        logger.info('Setting external thread ID for Teams channel %s conversation %s to threadId %s', channelId, conversationId, threadId);
        await conversationService.setExternalId(threadId, conversationId);
      }

      // Link DB record to the Teams message for feedback correlation
      const lastId = ids[ids.length - 1];
      if (messageId && lastId) {
        await conversationService.setExternalMessageId(messageId, lastId);
      }

      logger.info('Delivered message to Teams channel %s', mapping.teamsChannelName || channelId);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Teams channel delivery failed for %s: %s', channelId, errMsg);
    }
  }

  /**
   * Check if user has an active Teams link (personal or channel mapping).
   */
  async isUserConnected(userId: string): Promise<boolean> {
    if (!this.adapter) return false;
    const count = await teamsMappingService.countAllMappings(userId);
    return count > 0;
  }

  // ==========================================================================
  // Inbound turn handling
  // ==========================================================================

  /**
   * Bot Framework turn handler. Kept fast: the connector expects a response
   * within ~15s and may redeliver otherwise, so anything that can invoke the
   * LLM is detached and replies are sent proactively.
   */
  private async handleTurn(context: TurnContext): Promise<void> {
    const activity = context.activity;

    if (activity.type === ActivityTypes.Message) {
      // Snapshot the activity — the TurnContext is invalid once the HTTP
      // turn completes, but a plain activity object stays usable for
      // building conversation references.
      const snapshot = JSON.parse(JSON.stringify(activity)) as Activity;
      void this.processMessageActivity(snapshot).catch((error) => {
        logger.error(
          { err: error, conversationId: activity.conversation?.id, teamsUserId: activity.from?.id },
          'Error processing Teams message activity'
        );
      });
      return;
    }

    if (activity.type === ActivityTypes.ConversationUpdate) {
      const snapshot = JSON.parse(JSON.stringify(activity)) as Activity;
      void this.processConversationUpdate(snapshot).catch((error) => {
        logger.error({ err: error }, 'Error processing Teams conversationUpdate');
      });
    }
  }

  /**
   * Route an inbound message activity: feedback submits, personal chats,
   * and channel/group messages.
   */
  private async processMessageActivity(activity: Activity): Promise<void> {
    if (!this.connection) return;

    // Adaptive Card Action.Submit (feedback buttons) arrives as a message
    // with `value` and no text.
    const submitValue = activity.value as TeamsFeedbackSubmitValue | undefined;
    if (submitValue?.action && submitValue.messageId && !activity.text) {
      const rating: FeedbackRating =
        submitValue.action === FEEDBACK_ACTION_UP ? FEEDBACK_RATING_UP : FEEDBACK_RATING_DOWN;
      await this.handleFeedbackSubmit(activity, rating);
      return;
    }

    const rawText = (activity.text ?? '').trim();
    if (!rawText) {
      logger.info('Skipping Teams message without text');
      return;
    }

    const conversationType = activity.conversation?.conversationType;
    logger.info(
      'Processing Teams message: conversation=%s type=%s',
      activity.conversation?.id,
      conversationType,
    );

    if (conversationType === 'personal') {
      await this.handlePersonalMessage(activity, rawText);
    } else {
      await this.handleChannelMessage(activity, rawText);
    }
  }

  /**
   * Handle personal (1:1) chat messages — the Teams analogue of Slack DMs.
   */
  private async handlePersonalMessage(activity: Activity, rawText: string): Promise<void> {
    if (!this.connection) return;
    const connectionId = this.connection.id;
    const teamsUserId = activity.from?.id ?? '';
    const conversationId = activity.conversation?.id ?? '';

    logger.info('Teams personal message from %s', teamsUserId);

    try {
      const messageText = this.stripBotMention(rawText, activity);

      // Verification code check (6 hex chars, formatting stripped)
      const strippedText = messageText.replace(/[*_~`]/g, '').trim();
      if (this.isVerificationCode(strippedText)) {
        const result = await this.verifyDmLinkCode(
          strippedText.toUpperCase(),
          teamsUserId,
          conversationId,
          activity,
        );
        await this.replyToActivity(activity, result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
        return;
      }

      const mapping = await teamsMappingService.findUserMapping(connectionId, teamsUserId);

      if (!mapping) {
        await this.replyToActivity(
          activity,
          "👋 Hi! I don't recognize you yet.\n\nTo link your account:\n1. Go to **Settings → Channels** in the web app\n2. Click **Link Account** under Microsoft Teams\n3. Send me the 6-character code you receive\n\nOnce linked, you can chat with me here!"
        );
        return;
      }

      // Refresh the stored conversation reference so proactive delivery
      // (heartbeat/cron) always has a current route back.
      const reference = this.referenceFromActivity(activity);
      await teamsMappingService.updateConversationReference(
        mapping.id,
        conversationId,
        reference as unknown as Prisma.InputJsonValue,
      );

      const resolvedText = this.resolveMentions(messageText, activity);
      const taggedText = this.buildSenderTaggedContent(
        teamsUserId,
        activity.from?.name,
        resolvedText,
      );

      // Route through local conversation engine. metadata.channel scopes the
      // reply to Teams only — without it, delivery would broadcast and the
      // personal-chat reply would leak into webchat too.
      await conversationEngineService.chat({
        userId: mapping.lensUserId!,
        agentId: mapping.agentId,
        message: taggedText,
        metadata: { channel: 'teams' },
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { err: error, teamsUserId, conversationId },
        'Teams personal message processing error'
      );
      await this.replyToActivity(activity, `Sorry, I encountered an error processing your message: ${errMsg}`).catch(() => {});
    }
  }

  /**
   * Handle channel/group messages (team agent mode).
   *
   * Passive learning: queue messages for the agent to learn from.
   * Active response: only respond in threads the bot participates in or when
   * mentioned — mirrors the Slack adapter's flow.
   */
  private async handleChannelMessage(activity: Activity, rawText: string): Promise<void> {
    if (!this.connection) return;
    const connectionId = this.connection.id;
    const teamsUserId = activity.from?.id ?? '';
    const senderName = activity.from?.name;
    const conversationId = activity.conversation?.id ?? '';
    const channelId = this.channelIdFromActivity(activity);
    const isMentioned = this.isBotMentioned(activity);
    const messageText = this.stripBotMention(rawText, activity);

    // Verification code check FIRST (before channel link check) so an
    // unlinked channel can be linked via "@Bot ABC123".
    const strippedText = messageText.replace(/[*_~`]/g, '').trim();
    if (this.isVerificationCode(strippedText)) {
      logger.info('Received potential verification code in Teams channel %s', channelId);
      const result = await this.verifyAndLinkChannel(strippedText.toUpperCase(), channelId, activity);
      await this.replyToActivity(activity, result.success ? `✅ ${result.message}` : `❌ ${result.message}`).catch((sayError) => {
        logger.warn('Failed to post verification result in Teams channel %s: %s', channelId, sayError instanceof Error ? sayError.message : String(sayError));
      });
      return;
    }

    // Heartbeat trigger channel check
    const triggerCheck = await teamsHeartbeatTriggerService.isHeartbeatTriggerChannel(channelId);

    if (triggerCheck.isTrigger) {
      logger.info(`[TeamsAdapter] Heartbeat trigger received in channel ${channelId} for agent ${triggerCheck.agentId}`);

      await teamsMessageQueueService.enqueue(triggerCheck.agentId!, {
        sender: senderName || teamsUserId,
        text: messageText,
        timestamp: new Date().toISOString(),
      });
      // Fire-and-forget: throttle errors shouldn't surface to the user
      // since the message was already enqueued successfully
      this.throttledNotify(triggerCheck.agentId!).catch((err) => {
        logger.error('[TeamsAdapter] throttledNotify failed for agent %s: %s', triggerCheck.agentId, err instanceof Error ? err.message : String(err));
      });
      return;
    }

    // Check if channel is linked to an agent
    const mapping = await teamsMappingService.findByChannelId(channelId);
    if (!mapping) {
      if (isMentioned) {
        await this.replyToActivity(activity, "I'm not activated in this channel yet.\n\nPlease enter a verification code from your agent settings to link me.").catch(() => {});
      }
      return;
    }

    if (!mapping.lensUserId) {
      logger.warn('Teams channel mapping for %s has no lensUserId - skipping (legacy mapping?)', channelId);
      if (isMentioned) {
        await this.replyToActivity(activity, 'This channel has an incomplete configuration. Please unlink and re-link the channel.').catch(() => {});
      }
      return;
    }
    const userId = mapping.lensUserId;

    // Keep serviceUrl fresh so proactive channel delivery keeps working.
    if (activity.serviceUrl && activity.serviceUrl !== mapping.serviceUrl) {
      await teamsMappingService.updateChannelMapping(channelId, { serviceUrl: activity.serviceUrl }).catch(() => {});
    }

    const isThreadReply = this.isThreadReply(activity);

    logger.info(
      'Teams channel message from %s in %s (thread=%s, isMentioned=%s, text=%s)',
      teamsUserId,
      mapping.teamsChannelName || channelId,
      isThreadReply ? conversationId : 'top-level',
      isMentioned,
      messageText.slice(0, 80)
    );

    // Locate the local thread for this Teams conversation (exists only if
    // the bot has participated before).
    const existingThread = await prisma.conversationThread.findFirst({
      where: { agentId: mapping.agentId, externalThreadId: conversationId },
    });

    // For top-level messages, only respond if mentioned
    if (!isThreadReply && !isMentioned) {
      logger.info(
        'Queueing Teams channel message for learning: top-level message without bot mention (agent=%s, channel=%s)',
        mapping.agentId,
        mapping.teamsChannelName || channelId
      );
      await this.queueForLearning(mapping.agentId, userId, channelId, mapping.teamsChannelName, messageText, senderName);
      return;
    }

    // For thread replies without a mention, decide whether the bot should
    // respond. Teams bots can't fetch channel history, so the transcript
    // comes from locally stored messages.
    if (isThreadReply && !isMentioned) {
      const { result, messages } = await this.classifyThreadParticipation(existingThread?.id ?? null, messageText, teamsUserId);

      if (result.action !== 'respond') {
        // Teams bots can't add reactions, so 'react' degrades to learn-only.
        logger.info(
          'Queueing Teams channel message for learning: classifier action=%s (agent=%s, channel=%s)',
          result.action,
          mapping.agentId,
          mapping.teamsChannelName || channelId
        );
        // Keep the local transcript complete for future classification runs.
        if (existingThread) {
          await this.storeThreadMessage(existingThread.id, activity, messageText);
        }
        await this.queueForLearning(mapping.agentId, userId, channelId, mapping.teamsChannelName, messageText, senderName);
        return;
      }

      // Heuristic said respond — double-check with the LLM classifier.
      const llmResult = await this.classifyThreadMessage(messages, messageText, teamsUserId, senderName);

      if (llmResult.action !== 'respond') {
        logger.info(
          'Queueing Teams channel message for learning: LLM classifier action=%s (agent=%s, channel=%s)',
          llmResult.action,
          mapping.agentId,
          mapping.teamsChannelName || channelId
        );
        if (existingThread) {
          await this.storeThreadMessage(existingThread.id, activity, messageText);
        }
        await this.queueForLearning(mapping.agentId, userId, channelId, mapping.teamsChannelName, messageText, senderName);
        return;
      }
    }

    // Bot should respond — process through conversation engine
    try {
      const thread = await conversationService.getOrCreateThreadByExternalId(
        userId, mapping.agentId, conversationId, { channelId, source: 'TEAMS' }
      );

      await this.addParticipant(thread.id, teamsUserId, senderName || 'Unknown');

      const text = this.resolveMentions(messageText, activity);
      const taggedText = this.buildSenderTaggedContent(teamsUserId, senderName, text);

      await conversationEngineService.chat({
        userId,
        agentId: mapping.agentId,
        threadId: thread.id,
        message: taggedText,
        metadata: {
          channel: 'teams',
          channelId,
          teamsConversationId: conversationId,
          senderTeamsUserId: teamsUserId,
          senderName,
        },
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { err: error, teamsUserId, channelId, connectionId, conversationId },
        'Teams channel message processing error'
      );
      await this.replyToActivity(activity, `Sorry, I encountered an error: ${errMsg}`).catch(() => {});
    }
  }

  /**
   * Handle conversationUpdate activities: bot added to / removed from a
   * channel or team — mirrors Slack's member_joined_channel /
   * member_left_channel handlers.
   */
  private async processConversationUpdate(activity: Activity): Promise<void> {
    if (!this.connection) return;
    const botId = activity.recipient?.id;
    const channelId = this.channelIdFromActivity(activity);

    const botAdded = (activity.membersAdded ?? []).some((m) => m.id === botId);
    const botRemoved = (activity.membersRemoved ?? []).some((m) => m.id === botId);

    if (botAdded && activity.conversation?.conversationType !== 'personal') {
      logger.info('Bot added to Teams channel %s', channelId);

      const existingMapping = await teamsMappingService.findByChannelId(channelId);
      if (existingMapping) {
        logger.info('Teams channel %s already linked to an agent', channelId);
        return;
      }

      await this.replyToActivity(
        activity,
        "👋 Hi! I've been added to this channel.\n\nTo activate me, please enter the verification code from your agent settings.\nYou can find this in **Settings → Channels → Link to Channel**.",
      ).catch((error) => {
        logger.error('Failed to post welcome message to Teams channel %s: %s', channelId, error instanceof Error ? error.message : String(error));
      });
      return;
    }

    if (botRemoved && channelId) {
      logger.info('Bot removed from Teams channel %s', channelId);
      try {
        await teamsMappingService.deleteChannelMapping(channelId);
        logger.info('Removed Teams channel mapping for %s', channelId);
      } catch {
        // Mapping might not exist, that's fine
      }
    }
  }

  // ==========================================================================
  // Feedback (Adaptive Card Action.Submit)
  // ==========================================================================

  /**
   * Core feedback-click logic — the Teams analogue of the Slack adapter's
   * `handleFeedbackAction`. `activity.replyToId` is the id of the message
   * carrying the feedback card.
   */
  async handleFeedbackSubmit(activity: Activity, rating: FeedbackRating): Promise<void> {
    const submitValue = activity.value as TeamsFeedbackSubmitValue;
    const messageId = submitValue.messageId;
    const teamsUserId = activity.from?.id;
    const cardActivityId = activity.replyToId;

    if (!messageId || !teamsUserId || !cardActivityId) {
      logger.warn('[TeamsAdapter] Feedback submit missing required fields');
      return;
    }

    const conversationMessage = await prisma.conversationMessage.findFirst({
      where: { id: messageId, externalMessageId: cardActivityId },
      include: { thread: { select: { agentId: true } } },
    });

    if (!conversationMessage) {
      logger.warn('[TeamsAdapter] Feedback click for unknown message id=%s activity=%s', messageId, cardActivityId);
      // Still acknowledge so the user isn't left with dangling buttons.
      await this.replaceFeedbackCardWithAck(activity, cardActivityId, null);
      return;
    }

    trackEvent('message feedback', null, {
      'message.id': messageId,
      'thread.id': conversationMessage.threadId,
      'agent.id': conversationMessage.thread.agentId,
      'channel.type': 'teams',
      'feedback.rating': rating,
      'feedback.source': 'teams_adaptivecard',
      'teams.user.id': teamsUserId,
    });

    await this.replaceFeedbackCardWithAck(activity, cardActivityId, conversationMessage);
  }

  /**
   * Swap the feedback card on the original Teams message for an inline
   * "Thanks for the feedback!" card via updateActivity, then auto-remove
   * the ack after FEEDBACK_ACK_LINGER_MS — mirrors the Slack ack/linger.
   *
   * updateActivity replaces the whole message, so the original markdown is
   * re-derived from the stored ConversationMessage. When the message can't
   * be resolved, the update keeps an empty body with just the ack card.
   */
  private async replaceFeedbackCardWithAck(
    activity: Activity,
    cardActivityId: string,
    conversationMessage: ConversationMessage | null,
  ): Promise<void> {
    if (!this.adapter || !this.connection) return;

    // Re-derive the text that rode with the card: the card is attached to
    // the LAST chunk of the formatted message.
    let lastChunkText = '';
    if (conversationMessage) {
      const { chunks } = formatTeamsMessage(
        conversationMessage.content,
        conversationMessage.triggeredBy || undefined,
        (conversationMessage.toolCalls as Array<{ tool: string }>) ?? undefined,
      );
      lastChunkText = chunks[chunks.length - 1]?.text ?? '';
    }

    const reference = this.referenceFromActivity(activity);
    const appId = this.connection.appId;

    const update = async (attachments: unknown[]): Promise<void> => {
      await this.adapter!.continueConversationAsync(appId, reference, async (ctx) => {
        await ctx.updateActivity({
          id: cardActivityId,
          type: ActivityTypes.Message,
          text: lastChunkText,
          textFormat: 'markdown',
          attachments,
        } as Partial<Activity> as Activity);
      });
    };

    try {
      await update([buildFeedbackAckCard()]);
    } catch (error) {
      logger.warn(
        '[TeamsAdapter] Failed to replace feedback card with ack: %s',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    // Schedule the ack card to auto-remove so the message settles back to a
    // clean state. Best-effort: failures are logged and swallowed. unref() so
    // a pending timer doesn't keep the process alive on shutdown.
    const timer = setTimeout(() => {
      void update([]).catch((error) => {
        logger.warn(
          '[TeamsAdapter] Failed to clear feedback ack card: %s',
          error instanceof Error ? error.message : String(error),
        );
      });
    }, FEEDBACK_ACK_LINGER_MS);
    timer.unref?.();
  }

  // ==========================================================================
  // Verification codes
  // ==========================================================================

  private isVerificationCode(text: string): boolean {
    return /^[A-Fa-f0-9]{6}$/.test(text?.trim() || '');
  }

  /**
   * Verify a personal-chat link code (local Prisma — same logic as the
   * management route).
   */
  private async verifyDmLinkCode(
    code: string,
    teamsUserId: string,
    conversationId: string,
    activity: Activity,
  ): Promise<{ success: boolean; message: string }> {
    const upperCode = code.toUpperCase();
    const verification = await prisma.teamsVerificationCode.findUnique({
      where: { code_type: { code: upperCode, type: 'DM' } },
    });

    if (!verification) {
      return { success: false, message: 'Invalid code. Please generate a new code from the web app.' };
    }

    if (new Date() > verification.expiresAt) {
      await prisma.teamsVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'DM' } },
      }).catch(() => {});
      return { success: false, message: 'Code expired. Please generate a new code from the web app.' };
    }

    const existingLink = await prisma.teamsMapping.findFirst({
      where: {
        connectionId: verification.connectionId,
        teamsUserId,
      },
    });

    if (existingLink) {
      if (existingLink.lensUserId === verification.lensUserId) {
        return { success: false, message: 'Your Teams account is already linked to another agent. Unlink it first from that agent\'s settings.' };
      }
      return { success: false, message: 'This Teams account is already linked to another user.' };
    }

    const reference = this.referenceFromActivity(activity);

    // Atomic: create mapping + consume code
    await prisma.$transaction([
      prisma.teamsMapping.create({
        data: {
          connectionId: verification.connectionId,
          agentId: verification.agentId,
          teamsUserId,
          lensUserId: verification.lensUserId,
          personalConversationId: conversationId,
          conversationReference: reference as unknown as Prisma.InputJsonValue,
        },
      }),
      prisma.teamsVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'DM' } },
      }),
    ]);

    logger.info('Teams account linked via code: %s -> %s', teamsUserId, verification.lensUserId);

    return { success: true, message: 'Your Teams account is now linked! You can now chat with your agent here.' };
  }

  /**
   * Verify and link a channel to an agent.
   */
  private async verifyAndLinkChannel(
    code: string,
    channelId: string,
    activity: Activity,
  ): Promise<{ success: boolean; message: string; agentName?: string }> {
    try {
      const channelData = activity.channelData as { channel?: { name?: string }; tenant?: { id?: string } } | undefined;
      const channelName = channelData?.channel?.name;
      const tenantId = channelData?.tenant?.id ?? activity.conversation?.tenantId;

      const result = await this.verifyChannelLinkCodeLocal(
        code,
        channelId,
        channelName,
        activity.serviceUrl,
        tenantId,
      );

      if (result.success) {
        return {
          success: true,
          message: `Linked! I'm now connected to ${result.agentName || 'your agent'}. Mention me anytime you need help!`,
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
   * Verify a channel link code directly (local Prisma).
   */
  async verifyChannelLinkCodeLocal(
    code: string,
    channelId: string,
    channelName?: string,
    serviceUrl?: string,
    tenantId?: string,
  ): Promise<{ success: boolean; message: string; agentName?: string }> {
    const upperCode = code.toUpperCase();
    const verification = await prisma.teamsVerificationCode.findUnique({
      where: { code_type: { code: upperCode, type: 'CHANNEL' } },
    });

    if (!verification) {
      return { success: false, message: 'Invalid code. Please generate a new code from the web app.' };
    }

    if (new Date() > verification.expiresAt) {
      await prisma.teamsVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'CHANNEL' } },
      }).catch(() => {});
      return { success: false, message: 'Code expired. Please generate a new code from the web app.' };
    }

    const existingChannelLink = await prisma.teamsMapping.findUnique({
      where: { teamsChannelId: channelId },
    });

    if (existingChannelLink) {
      return { success: false, message: 'This channel is already linked to an agent.' };
    }

    // Atomic: create channel mapping + consume code
    await prisma.$transaction([
      prisma.teamsMapping.create({
        data: {
          connectionId: verification.connectionId,
          agentId: verification.agentId,
          teamsChannelId: channelId,
          teamsChannelName: channelName || channelId,
          lensUserId: verification.lensUserId,
          teamsUserId: null,
          personalConversationId: null,
          serviceUrl,
          tenantId,
        },
      }),
      prisma.teamsVerificationCode.delete({
        where: { code_type: { code: upperCode, type: 'CHANNEL' } },
      }),
    ]);

    logger.info('Teams channel linked via code: %s -> %s\'s agent', channelId, verification.lensUserId);

    return {
      success: true,
      message: `Channel linked to ${verification.agentName}!`,
      agentName: verification.agentName ?? undefined,
    };
  }

  /**
   * Create or update a user mapping. Called from the management API when a
   * Teams user is linked out-of-band (mirror of `linkSlackUser`). Without an
   * inbound activity there's no conversation reference yet — it's captured
   * on the user's first personal-chat message.
   */
  async linkTeamsUser(
    connectionId: string,
    teamsUserId: string,
    lensUserId: string,
    agentId: string,
    personalConversationId?: string
  ): Promise<void> {
    await teamsMappingService.upsertUserMapping(connectionId, teamsUserId, lensUserId, agentId, personalConversationId);
    logger.info('Linked Teams user %s to Lens user %s', teamsUserId, lensUserId);
  }

  /**
   * Get a channel's display name. Teams bots can't query channel info
   * outside a turn, so this falls back to the stored mapping name.
   */
  async getChannelName(channelId: string): Promise<string | null> {
    const mapping = await teamsMappingService.findByChannelId(channelId);
    return mapping?.teamsChannelName ?? null;
  }

  // ==========================================================================
  // Thread participation / classification
  // ==========================================================================

  /**
   * Heuristic pass over the locally stored thread transcript — the Teams
   * analogue of the Slack adapter's `isBotInThread` (which reads the Slack
   * API; Teams bots can't fetch channel history).
   */
  private async classifyThreadParticipation(
    threadId: string | null,
    _messageText: string,
    _senderId: string,
  ): Promise<{ result: ThreadAction; messages: Array<{ role: string; sender: string | null; text: string }> }> {
    if (!threadId) {
      // Bot never participated in this thread
      return { result: { action: 'ignore' }, messages: [] };
    }

    const dbMessages = await prisma.conversationMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { role: true, senderName: true, senderExternalId: true, content: true },
    });

    const messages = dbMessages.map((m) => ({
      role: m.role,
      sender: m.senderName ?? m.senderExternalId,
      text: m.content,
    }));

    let lastBotIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'AGENT') {
        lastBotIndex = i;
        break;
      }
    }

    // Bot never posted in this thread
    if (lastBotIndex === -1) return { result: { action: 'ignore' }, messages };

    // Check if conversation branched to another user after bot's last reply
    for (let i = lastBotIndex + 1; i < messages.length; i++) {
      const text = messages[i].text || '';
      if (TEAMS_MENTION_TOKEN.test(text)) {
        TEAMS_MENTION_TOKEN.lastIndex = 0;
        return { result: { action: 'react', emoji: 'eyes' }, messages };
      }
      TEAMS_MENTION_TOKEN.lastIndex = 0;
    }

    // Bot is participating and no branching detected — pass to LLM
    return { result: { action: 'respond' }, messages };
  }

  /**
   * Classify a thread message using a lightweight LLM (Haiku) — second pass
   * after the heuristic, same contract as the Slack adapter.
   */
  private async classifyThreadMessage(
    messages: Array<{ role: string; sender: string | null; text: string }>,
    latestText: string,
    latestSenderId: string,
    latestSenderName?: string,
  ): Promise<ThreadAction> {
    try {
      const recent = messages.slice(-10);
      const transcript = [
        ...recent.map((m) => {
          const label = m.role === 'AGENT' ? '[Bot]' : `[User:${m.sender ?? 'unknown'}]`;
          return `${label}: ${m.text}`;
        }),
        `[User:${latestSenderName ?? latestSenderId}]: ${latestText}`,
      ].join('\n');

      const { object } = await generateObject({
        model: getClassificationModel(),
        schema: threadClassificationSchema,
        temperature: 0,
        system: [
          'You are a Microsoft Teams thread classifier for an AI assistant bot.',
          'Given the recent messages in a thread, decide what the bot should do with the LAST message.',
          '',
          'Return a JSON object with:',
          '- action: "respond" if the last message is directed at the bot or expects the bot to answer',
          '- action: "react" if the bot should acknowledge it read the message but not reply (e.g. someone is talking to another human)',
          '- action: "ignore" if the message is completely irrelevant to the bot',
        ].join('\n'),
        prompt: transcript,
      });

      if (object.action === 'react') {
        return { action: 'react', emoji: object.emoji ?? 'eyes' };
      }
      return { action: object.action };
    } catch (error) {
      logger.warn('Teams thread classification failed, falling back to respond: %s', error instanceof Error ? error.message : String(error));
      return { action: 'respond' };
    }
  }

  /**
   * Store a thread message the bot decided not to respond to, so the local
   * transcript (used for future classification and as LLM context for
   * TEAMS-source threads) stays complete.
   */
  private async storeThreadMessage(threadId: string, activity: Activity, messageText: string): Promise<void> {
    try {
      const teamsUserId = activity.from?.id ?? '';
      const senderName = activity.from?.name;
      const resolved = this.resolveMentions(messageText, activity);
      await conversationService.addMessage(threadId, {
        content: this.buildSenderTaggedContent(teamsUserId, senderName, resolved),
        role: 'USER',
        triggeredBy: 'USER_INPUT',
        senderExternalId: teamsUserId,
        senderName,
      });
    } catch (error) {
      logger.warn('Failed to store Teams thread message: %s', error instanceof Error ? error.message : String(error));
    }
  }

  // ==========================================================================
  // Mentions
  // ==========================================================================

  /** True when the inbound activity @mentions the bot. */
  private isBotMentioned(activity: Activity): boolean {
    const botId = activity.recipient?.id;
    return ((activity.entities ?? []) as MentionEntity[]).some(
      (e) => e.type === 'mention' && e.mentioned?.id === botId,
    );
  }

  /**
   * Remove the bot's own `<at>…</at>` mention token from inbound message
   * text, using the activity's mention entities to identify which token is
   * the bot's. User mentions are left intact for resolveMentions.
   */
  private stripBotMention(text: string, activity: Activity): string {
    const botId = activity.recipient?.id;
    let result = text;
    for (const entity of (activity.entities ?? []) as MentionEntity[]) {
      if (entity.type !== 'mention' || entity.mentioned?.id !== botId) continue;
      const token = entity.text || (entity.mentioned?.name ? `<at>${entity.mentioned.name}</at>` : null);
      if (token) {
        result = result.split(token).join(' ');
      }
    }
    return result.replace(/\s{2,}/g, ' ').trim();
  }

  /**
   * Resolve user mentions on inbound Teams text.
   *
   * Rewrites each `<at>Name</at>` token to the combined form
   * `<@TEAMSID|displayName>` using the activity's mention entities, so
   * downstream consumers (the agent, stored history) see both the canonical
   * id and a human-readable name. The bot's own mention is removed.
   * `rewriteOutboundMentions()` is the inverse, applied before delivery.
   */
  private resolveMentions(text: string, activity: Activity): string {
    const botId = activity.recipient?.id;
    let resolved = text;

    for (const entity of (activity.entities ?? []) as MentionEntity[]) {
      if (entity.type !== 'mention' || !entity.mentioned?.id) continue;

      const token = entity.text || (entity.mentioned.name ? `<at>${entity.mentioned.name}</at>` : null);
      if (!token) continue;

      if (entity.mentioned.id === botId) {
        resolved = resolved.split(token).join('').trim();
        continue;
      }

      const rawName = entity.mentioned.name || entity.mentioned.id;
      // Sanitize: strip `>`, `|`, and control chars so the combined marker
      // stays unambiguous for the inverse regex.
      const sanitizedName = rawName.replace(/[<>|\x00-\x1f]/g, '').trim() || entity.mentioned.id;
      resolved = resolved.split(token).join(`<@${entity.mentioned.id}|${sanitizedName}>`);
    }

    return resolved.trim();
  }

  /**
   * Build the sender-tagged form of an inbound message — `<@ID|Name>: text`.
   * The agent's conversation history then carries the speaker's canonical
   * mention token, which the agent can copy verbatim into a reply (where
   * `rewriteOutboundMentions()` turns it into a real Teams mention).
   */
  private buildSenderTaggedContent(
    teamsUserId: string,
    senderName: string | undefined,
    text: string,
  ): string {
    if (!senderName) return text;
    const sanitized = senderName.replace(/[<>|\x00-\x1f]/g, '').trim();
    const tag = sanitized ? `<@${teamsUserId}|${sanitized}>` : `<@${teamsUserId}>`;
    return `${tag}: ${text}`;
  }

  /**
   * Inverse of {@link resolveMentions} for outbound delivery.
   *
   * Converts each `<@TEAMSID|displayName>` token the agent emitted into a
   * Teams mention: `<at>displayName</at>` in the text plus a matching
   * mention entity, which Teams renders as a real mention and notifies the
   * user. Tokens whose id doesn't look like a Teams id (or that lack a
   * display name) are downgraded to plain `@displayName` / dropped.
   */
  rewriteOutboundMentions(text: string): { text: string; entities: MentionEntity[] } {
    const matches = [...text.matchAll(TEAMS_MENTION_TOKEN)];
    if (matches.length === 0) return { text, entities: [] };

    let resolved = text;
    const entities: MentionEntity[] = [];

    for (const match of matches) {
      const [token, id, embeddedName] = match;
      if (embeddedName && TEAMS_USER_ID_PATTERN.test(id)) {
        const atToken = `<at>${embeddedName}</at>`;
        resolved = resolved.split(token).join(atToken);
        if (!entities.some((e) => e.mentioned?.id === id && e.text === atToken)) {
          entities.push({
            type: 'mention',
            text: atToken,
            mentioned: { id, name: embeddedName },
          });
        }
      } else if (embeddedName) {
        logger.info('Downgrading unknown Teams mention %s to plain text', id);
        resolved = resolved.split(token).join(`@${embeddedName}`);
      } else {
        logger.info('Dropping unknown bare Teams mention %s', id);
        resolved = resolved.split(token).join('');
      }
    }

    return { text: resolved, entities };
  }

  // ==========================================================================
  // Outbound send plumbing
  // ==========================================================================

  /**
   * Prepare agent output for delivery: rewrite mention tokens, format
   * markdown, and attach mention entities to each chunk. All delivery paths
   * route through this so mentions never silently degrade.
   */
  private prepareOutboundMessage(
    content: string,
    triggeredBy: string | undefined,
    toolCalls: Array<{ tool: string }> | undefined,
    options: FormatTeamsMessageOptions | undefined,
  ): Array<FormattedTeamsMessage & { entities?: MentionEntity[] }> {
    const { text, entities } = this.rewriteOutboundMentions(content);
    const { chunks } = formatTeamsMessage(text, triggeredBy, toolCalls, options);
    if (entities.length === 0) return chunks;
    return chunks.map((chunk) => ({
      ...chunk,
      // Only attach the entities whose <at> token actually appears in this chunk
      entities: entities.filter((e) => e.text && chunk.text.includes(e.text)),
    }));
  }

  /**
   * Send formatted chunks proactively into a conversation. Mention entities
   * are stripped-and-retried on failure so a stale/hallucinated mention id
   * can't block delivery.
   */
  private async sendToReference(
    reference: Partial<ConversationReference>,
    chunks: Array<FormattedTeamsMessage & { entities?: MentionEntity[] }>,
  ): Promise<string[]> {
    if (!this.adapter || !this.connection) {
      throw new Error('Teams adapter not initialized');
    }

    const ids: string[] = [];
    await this.adapter.continueConversationAsync(this.connection.appId, reference, async (ctx) => {
      for (const chunk of chunks) {
        const baseActivity: Partial<Activity> = {
          type: ActivityTypes.Message,
          text: chunk.text,
          textFormat: chunk.textFormat,
          ...(chunk.attachments && { attachments: chunk.attachments }),
          ...(chunk.entities && chunk.entities.length > 0 && { entities: chunk.entities }),
        };
        let response;
        try {
          response = await ctx.sendActivity(baseActivity as Activity);
        } catch (error) {
          if (chunk.entities && chunk.entities.length > 0) {
            // Mention entity rejected (e.g. user not in conversation) —
            // retry as plain text so the message still lands.
            logger.warn('Teams send with mentions failed, retrying without entities: %s', error instanceof Error ? error.message : String(error));
            const { entities: _entities, ...withoutEntities } = baseActivity;
            response = await ctx.sendActivity(withoutEntities as Activity);
          } else {
            throw error;
          }
        }
        if (response?.id) ids.push(response.id);
      }
    });
    return ids;
  }

  /**
   * Reply into the conversation an activity came from (proactively — the
   * originating HTTP turn may already be complete).
   */
  private async replyToActivity(activity: Activity, text: string): Promise<void> {
    const reference = this.referenceFromActivity(activity);
    await this.sendToReference(reference, [{ text, textFormat: 'markdown' }]);
  }

  /** Build a ConversationReference from an inbound activity snapshot. */
  private referenceFromActivity(activity: Activity): Partial<ConversationReference> {
    return TurnContext.getConversationReference(activity);
  }

  /** Build a ConversationReference for a channel conversation id. */
  private buildConversationReference(
    serviceUrl: string,
    conversationId: string,
    tenantId?: string | null,
  ): Partial<ConversationReference> {
    return {
      bot: { id: this.connection?.botId ?? '', name: 'bot', role: 'bot' },
      channelId: 'msteams',
      serviceUrl,
      conversation: {
        id: conversationId,
        isGroup: true,
        conversationType: 'channel',
        name: '',
        ...(tenantId && { tenantId }),
      },
    } as Partial<ConversationReference>;
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * The raw channel id for an activity — `channelData.channel.id` when
   * present (channel messages), else the conversation id with any
   * `;messageid=` thread suffix stripped (group chats, conversationUpdate).
   */
  private channelIdFromActivity(activity: Activity): string {
    const channelData = activity.channelData as { channel?: { id?: string } } | undefined;
    if (channelData?.channel?.id) return channelData.channel.id;
    const conversationId = activity.conversation?.id ?? '';
    return conversationId.split(';messageid=')[0];
  }

  /**
   * True when the activity is a reply inside an existing thread rather than
   * a new top-level channel post. In channels the conversation id carries
   * `;messageid=<rootId>`; for the root post itself the root id equals the
   * activity's own id.
   */
  private isThreadReply(activity: Activity): boolean {
    const conversationId = activity.conversation?.id ?? '';
    const match = conversationId.match(/;messageid=(.+)$/);
    if (!match) return false;
    return match[1] !== activity.id;
  }

  /**
   * Notify with throttle awareness — attempts an atomic claim on the
   * trigger; if throttled, schedules a deferred notification.
   */
  private async throttledNotify(agentId: string): Promise<void> {
    const result = await teamsHeartbeatTriggerService.tryClaimTrigger();

    if (result.claimed) {
      try {
        heartbeatService.triggerFromChannel();
      } catch (error) {
        logger.error('[TeamsThrottledNotify] Failed to trigger heartbeat for agent %s: %s', agentId, error instanceof Error ? error.message : String(error));
      }
    } else if (result.remainingSeconds && result.remainingSeconds > 0) {
      await getTeamsHeartbeatThrottleQueue().scheduleDeferred(agentId, result.remainingSeconds);
    }
  }

  /**
   * Queue a message for passive learning.
   */
  private async queueForLearning(
    agentId: string,
    userId: string,
    channelId: string,
    channelName: string | null | undefined,
    messageText: string,
    senderName: string | undefined,
  ): Promise<void> {
    await channelLearningQueue.add({
      agentId,
      userId,
      channelId,
      channelName: channelName ?? undefined,
      message: messageText,
      senderName,
      timestamp: Date.now(),
    });
  }

  /**
   * Add a participant to a conversation thread.
   */
  private async addParticipant(threadId: string, externalUserId: string, displayName: string): Promise<void> {
    try {
      await prisma.conversationParticipant.upsert({
        where: {
          threadId_externalUserId_channel: {
            threadId,
            externalUserId,
            channel: 'teams',
          },
        },
        update: {
          displayName,
        },
        create: {
          threadId,
          externalUserId,
          displayName,
          channel: 'teams',
        },
      });
    } catch (error: unknown) {
      // Log but don't fail if participant tracking fails
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to add Teams participant %s: %s', externalUserId, message);
    }
  }
}

// Export singleton instance
export const teamsAdapterService = new TeamsAdapterService();
