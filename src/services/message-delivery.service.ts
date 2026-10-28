/**
 * Message Delivery Service
 *
 * Unified entry point for all agent messages. Provides a single publish() function
 * that handles both persistence (storing in DB) and delivery (sending to all channels).
 *
 * Key design principles:
 * - All agent messages go through publish() - one function for store + deliver
 * - Callers don't need to know about channels or database details
 * - Adding new channels requires zero changes to calling code
 * - Consistent logging and error handling across all channels
 */

import { EventEmitter } from 'node:events';
import { ConversationMessage } from '@prisma/client';
import {
  ChannelAdapter,
  ChannelContext,
  ChannelDestination,
  ChannelName,
  DeliverableMessage,
  isChatPlatform,
} from './channel-adapter.interface';
import { conversationService } from './conversation.service';
import { attachmentService } from './attachment.service';
import { logger } from '../logger';
import type { ToolCallRecord } from '../types';

// ============================================================================
// Types
// ============================================================================

/**
 * What triggered this message.
 *
 * Exported as a value as well as a type, so an incoming trigger can be validated
 * against it. The Prisma enum cannot serve that: it still declares SYSTEM, which
 * nothing produces.
 */
export const MESSAGE_TRIGGERS = ['USER_INPUT', 'HEARTBEAT', 'CRON_TASK', 'GOAL', 'WEBHOOK'] as const;

export type MessageTrigger = (typeof MESSAGE_TRIGGERS)[number];

/**
 * Options for publishing a message
 */
export interface PublishOptions {
  /** The webhook subscription that produced a WEBHOOK message, for the model's history. */
  triggerName?: string;
  /** Tool calls made during message generation */
  toolCalls?: ToolCallRecord[];
  /** UI blocks for rich rendering */
  blocks?: unknown[];
  /**
   * Ids of files the agent shared (via share_file) to deliver with this
   * message. They're linked to the stored message and rendered/uploaded by
   * each channel adapter. Already-linked or forged ids are ignored at link
   * time (attachmentService caps and only claims unlinked rows).
   */
  attachmentIds?: string[];
  /**
   * Per-message context: routing (channel/channelId/channelThreadId) + rendering
   * hints (e.g. `includeFeedback`). The caller (conversation engine for
   * user turns; heartbeat/cron leave it undefined) is the single owner of
   * this object — `publish` just forwards it.
   */
  channelContext?: ChannelContext;
}

/**
 * Result of delivery to a single adapter
 */
interface DeliveryResult {
  adapter: string;
  delivered: boolean;
  reason?: string;
}

// ============================================================================
// Message Delivery Service
// ============================================================================

export class MessageDeliveryService {
  /** Emits `published` with each agent message once it is stored and delivered. */
  readonly events = new EventEmitter();
  private adapters: ChannelAdapter[] = [];

  /**
   * Register a channel adapter
   */
  register(adapter: ChannelAdapter): void {
    this.adapters.push(adapter);
    logger.info('Registered channel adapter: %s', adapter.name);
  }

  /**
   * Get all registered adapters (for testing)
   */
  getAdapters(): readonly ChannelAdapter[] {
    return this.adapters;
  }

  /** The registered adapter named `name`. */
  getAdapter(name: string): ChannelAdapter | undefined {
    return this.adapters.find((adapter) => adapter.name === name);
  }

  /**
   * The delivery context for an autonomous message that continues `threadId`
   * where it started: the stored origin channel, and the destination that
   * channel's adapter reconstructs from the thread. A thread with no stored
   * origin started in the chat socket.
   */
  async threadContext(
    threadId: string,
    originChannel?: string | null,
    originChannelId?: string | null,
  ): Promise<ChannelContext & ChannelDestination> {
    const channel: ChannelName = isChatPlatform(originChannel) ? originChannel : 'websocket';
    const destination = await this.getAdapter(channel)?.threadDestination?.(
      threadId,
      originChannelId ?? undefined,
    );
    return { channel, threadId, ...destination };
  }

  /**
   * SINGLE FUNCTION: Store message in DB + deliver to all channels
   */
  async publish(
    userId: string,
    threadId: string,
    content: string,
    triggeredBy: MessageTrigger,
    options?: PublishOptions
  ): Promise<ConversationMessage> {
    // 1. Store in database directly via Prisma, in the thread clients show
    threadId = await conversationService.writableThreadId(threadId);
    const { message } = await conversationService.addMessage(threadId, {
      content,
      role: 'AGENT',
      triggeredBy,
      triggerName: options?.triggerName,
      toolCalls: options?.toolCalls,
      blocks: options?.blocks,
    });

    // 2. Link any agent-shared files to this message and load their metadata
    // (no bytes) so adapters can render/upload them. linkToMessage only claims
    // unlinked rows and caps the count, so forged/duplicate ids are safe.
    // Deliver a shallow copy with the metadata, and with the tool calls of the
    // steps a concise turn hid — the persisted message we return stays a clean
    // ConversationMessage (no extra fields leak out).
    let deliverable: DeliverableMessage = (await conversationService.withHiddenStepToolCalls(threadId, [message]))[0];
    if (options?.attachmentIds?.length) {
      await attachmentService.linkToMessage(options.attachmentIds, message.id, threadId);
      const metaMap = await attachmentService.getMetaByMessageIds([message.id]);
      const attachments = metaMap.get(message.id);
      if (attachments?.length) deliverable = { ...deliverable, attachments };
    }

    // 3. Deliver to all connected channels.
    // channelContext is the single source of routing + rendering hints; we
    // forward it as-is and let the adapter decide what to do with it.
    await this.deliverToAll(userId, deliverable, options?.channelContext);
    this.events.emit('published', message);

    return message;
  }

  /**
   * Publish a message for autonomous background services (heartbeat, cron)
   *
   * Gets or creates the latest thread for the user before publishing.
   */
  async publishToLatestThread(
    agentId: string,
    userId: string,
    content: string,
    // Autonomous triggers only — a user message always has a thread of its own.
    triggeredBy: 'HEARTBEAT' | 'CRON_TASK' | 'GOAL' | 'WEBHOOK',
    options?: PublishOptions
  ): Promise<ConversationMessage> {
    // Resolve (or create) the latest thread for this user
    const thread = await conversationService.getOrCreateLatestThread(agentId, userId);

    // Use the standard publish method
    return this.publish(userId, thread.id, content, triggeredBy, options);
  }

  /** Publish an autonomous message to web chat only, in the web-visible latest thread. */
  async publishToWebChat(
    agentId: string,
    userId: string,
    content: string,
    triggeredBy: MessageTrigger,
    options?: Omit<PublishOptions, 'channelContext'>,
  ): Promise<ConversationMessage> {
    const thread = await conversationService.getOrCreateLatestThread(agentId, userId);
    return this.publish(userId, thread.id, content, triggeredBy, {
      ...options,
      channelContext: { channel: 'websocket', threadId: thread.id },
    });
  }

  /**
   * Send a stored message that `publish` does not, to every channel that shows
   * the whole conversation. There are two such messages:
   *
   * - A person's own message. Only those channels show it, so a message sent
   *   from one device appears on the others.
   * - A message changed after it was published. The one today is a computer
   *   help card: answering it changes its status, and every open client has to
   *   stop offering to answer it.
   *
   * A channel that posts only the agent's replies is skipped: it shows a
   * person's message itself, and posting a change there would post the message
   * twice.
   */
  async showInConversation(userId: string, message: ConversationMessage): Promise<void> {
    const channels = this.adapters.filter((adapter) => adapter.showsWholeConversation);
    if (channels.length === 0) return;
    const attachments = (await attachmentService.getMetaByMessageIds([message.id])).get(message.id);
    const [shown] = await conversationService.withHiddenStepToolCalls(message.threadId, [message]);
    const deliverable: DeliverableMessage = attachments?.length ? { ...shown, attachments } : shown;
    await Promise.all(
      channels.map(async (adapter) => {
        try {
          await adapter.deliver(userId, deliverable);
        } catch (error: unknown) {
          logger.error('Failed to show a message via %s: %s', adapter.name, error instanceof Error ? error.message : String(error));
        }
      }),
    );
  }

  /**
   * Internal: Deliver to all connected channels
   */
  private async deliverToAll(
    userId: string,
    message: DeliverableMessage,
    channelContext?: PublishOptions['channelContext']
  ): Promise<void> {
    if (this.adapters.length === 0) {
      logger.warn('No channel adapters registered, message stored but not delivered');
      return;
    }

    // Fail-closed: USER_INPUT replies must always be scoped to a channel.
    // If a caller forgot to pass channelContext, broadcasting would leak the
    // reply to every connected adapter, a direct message's answer included.
    // Better to log loudly and drop delivery than to leak.
    // Heartbeat/cron (HEARTBEAT/CRON_TASK) legitimately broadcast and are unaffected.
    if (!channelContext && message.triggeredBy === 'USER_INPUT') {
      logger.error(
        '[MessageDelivery] user-input message %s (thread %s) lacks channelContext — skipping delivery to prevent cross-channel leak',
        message.id,
        message.threadId,
      );
      return;
    }

    const results = await Promise.allSettled(
      this.adapters.map(async (adapter): Promise<DeliveryResult> => {
        try {
          // When channelContext is set (user-initiated), only deliver to the originating channel.
          // When channelContext is absent (heartbeat/cron), broadcast to all connected channels.
          if (channelContext) {
            if (channelContext.channel !== adapter.name) {
              return { adapter: adapter.name, delivered: false, reason: 'not originating channel' };
            }
          }
          const connected = await adapter.isUserConnected(userId);
          if (connected) {
            await adapter.deliver(userId, message, channelContext);
            return { adapter: adapter.name, delivered: true };
          }
          return { adapter: adapter.name, delivered: false, reason: 'not connected' };
        } catch (error: unknown) {
          logger.error('Failed to deliver via %s: %s', adapter.name, error instanceof Error ? error.message : String(error));
          return { adapter: adapter.name, delivered: false, reason: error instanceof Error ? error.message : String(error) };
        }
      })
    );

    const delivered = results.filter(
      (r) => r.status === 'fulfilled' && r.value.delivered
    ).length;

    const adapterStatuses = results.map((r) => {
      if (r.status === 'fulfilled') {
        return r.value.delivered ? `${r.value.adapter}:✓` : `${r.value.adapter}:✗`;
      }
      return `unknown:err`;
    });

    logger.info(
      'Message delivered to %d/%d channel(s) for user %s [%s]',
      delivered, this.adapters.length, userId, adapterStatuses.join(', ')
    );
  }

  /**
   * Initialize all registered adapters
   */
  async initializeAll(): Promise<void> {
    logger.info('Initializing %d channel adapter(s)', this.adapters.length);

    for (const adapter of this.adapters) {
      try {
        await adapter.initialize();
        logger.info('%s adapter initialized', adapter.name);
      } catch (error: unknown) {
        logger.error('Failed to initialize %s: %s', adapter.name, error instanceof Error ? error.message : String(error));
      }
    }
  }

  /**
   * Shutdown all registered adapters
   */
  async shutdownAll(): Promise<void> {
    logger.info('Shutting down %d channel adapter(s)', this.adapters.length);

    for (const adapter of this.adapters) {
      try {
        await adapter.shutdown();
        logger.info('%s adapter shut down', adapter.name);
      } catch (error: unknown) {
        logger.error('Failed to shutdown %s: %s', adapter.name, error instanceof Error ? error.message : String(error));
      }
    }
  }

  /**
   * Check if any adapter has an active connection for a user
   */
  async isUserConnectedToAny(userId: string): Promise<boolean> {
    for (const adapter of this.adapters) {
      try {
        if (await adapter.isUserConnected(userId)) {
          return true;
        }
      } catch {
        // Ignore errors, continue checking
      }
    }
    return false;
  }
}

// Export singleton instance
export const messageDeliveryService = new MessageDeliveryService();
