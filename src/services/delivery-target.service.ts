/**
 * Delivery Target Service
 *
 * Delivers an autonomous message to the target its source was configured with:
 * every channel, web chat only, one channel's default destination, chosen
 * linked channels of a channel, or nowhere. Webhook subscriptions and scheduled
 * tasks each store a target.
 */

import type { ConversationMessage } from '@prisma/client';
import { messageDeliveryService, type PublishOptions } from './message-delivery.service';
import { conversationService } from './conversation.service';
import { CHAT_PLATFORMS, type ChannelName } from './channel-adapter.interface';
import { logger } from '../logger';
import type { InvokeRequest } from '../types';

export const DELIVER_TARGETS = ['all', 'chat', ...CHAT_PLATFORMS, 'none'] as const;
export type DeliverTo = (typeof DELIVER_TARGETS)[number];

export function isValidDeliverTo(value: unknown): value is DeliverTo {
  return typeof value === 'string' && (DELIVER_TARGETS as readonly string[]).includes(value);
}

/** Parse a stored comma-separated column; null or empty is an empty list. */
export function parseCommaList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

/** Where a message goes: the target, and the linked channels chosen for it, if any. */
export interface DeliveryTarget {
  deliverTo: string;
  channelIds: string[];
}

/**
 * What a delivery stored: the message, or null for 'none'. A delivery to chosen
 * channels also counts the channels it posted to and the unlinked ones it
 * skipped.
 */
export interface Delivery {
  message: ConversationMessage | null;
  chosenChannels?: { channel: ChannelName; posted: number; skipped: number };
}

/** The triggers of a message that a target delivers. */
type TargetTrigger = 'CRON_TASK' | 'WEBHOOK';

type TargetPublishOptions = Pick<PublishOptions, 'triggerName' | 'toolCalls' | 'attachmentIds'>;

class DeliveryTargetService {
  /**
   * Deliver a message: to the chosen channels when the target's channel links
   * channels and some are chosen, else per the target.
   */
  async deliver(
    agentId: string,
    userId: string,
    target: DeliveryTarget,
    content: string,
    triggeredBy: TargetTrigger,
    options: TargetPublishOptions = {},
  ): Promise<Delivery> {
    const channel = messageDeliveryService.getAdapter(target.deliverTo);
    if (target.channelIds.length > 0 && channel?.linkedChannelIds) {
      const linked = new Set(await channel.linkedChannelIds(agentId));
      return this.deliverToChosenChannels(agentId, userId, channel.name, linked, target.channelIds, content, triggeredBy, options);
    }
    return { message: await this.deliverToTarget(agentId, userId, target.deliverTo, content, triggeredBy, options) };
  }

  /**
   * Where `deliver` posts the final message, so `send_message` refuses it as a
   * target: the broadcast for 'all', and for a single platform its one
   * conversation. A platform without one gets the message in web chat only, and
   * 'chat' and 'none' reach no channel. A send into a chosen channel is not
   * refused: the prompt rule asks the agent not to post its final message there.
   */
  async outputTarget(
    agentId: string,
    userId: string,
    target: DeliveryTarget,
  ): Promise<Pick<InvokeRequest, 'broadcastsOutput' | 'outputDestination'>> {
    if (target.deliverTo === 'all') return { broadcastsOutput: true };
    const channel = messageDeliveryService.getAdapter(target.deliverTo);
    if (!channel?.defaultDestination) return {};
    if (target.channelIds.length > 0 && channel.linkedChannelIds) return {};
    const destination = await channel.defaultDestination(agentId, userId);
    if (!destination) return {};
    return { outputDestination: { platform: channel.name, conversationId: destination.threadKey } };
  }

  /**
   * Read a channel list from a request, as the stored column value. The list
   * belongs to a target whose channel links channels. Each id has to name a
   * channel linked to the agent, or one the source already holds, so a channel
   * unlinked after it was chosen does not block an unrelated edit.
   */
  async readChannelIds(
    raw: unknown,
    deliverTo: string,
    agentId: string,
    stored: string[],
  ): Promise<{ ok: false; error: string } | { ok: true; value: string | null }> {
    // null clears the list, as it clears the nullable fields beside it.
    const list = raw === null ? [] : raw;
    if (!Array.isArray(list) || list.some((id) => typeof id !== 'string')) {
      return { ok: false, error: 'The channel list must be an array of channel ids' };
    }
    const ids = [...new Set((list as string[]).map((id) => id.trim()).filter((id) => id.length > 0))];
    if (ids.length === 0) return { ok: true, value: null };
    const channel = messageDeliveryService.getAdapter(deliverTo);
    if (!channel?.linkedChannelIds) {
      return { ok: false, error: `Chosen channels do not apply when the target is '${deliverTo}'` };
    }
    const linked = new Set(await channel.linkedChannelIds(agentId));
    const unknown = ids.filter((id) => !linked.has(id) && !stored.includes(id));
    if (unknown.length > 0) {
      return { ok: false, error: `Not a channel linked to the agent: ${unknown.join(', ')}` };
    }
    return { ok: true, value: ids.join(',') };
  }

  /**
   * Deliver a message per the target, and return the stored message, or null
   * for 'none':
   * - 'all' — broadcast to every connected channel, in the latest thread.
   * - 'chat' — scoped to web chat; stored in the web-visible latest thread.
   * - a channel's name — scoped to that channel's default destination (the
   *   direct conversation, else the main channel). Stored in the destination's
   *   own thread, keyed by a non-null externalThreadId, so `listThreads` hides
   *   it from web Recents + the CLI resume picker. Falls back to web chat only
   *   + a warning when the channel has no destination.
   * - 'none' — nothing is published or stored.
   */
  private async deliverToTarget(
    agentId: string,
    userId: string,
    deliverTo: string,
    content: string,
    triggeredBy: TargetTrigger,
    options: TargetPublishOptions,
  ): Promise<ConversationMessage | null> {
    if (deliverTo === 'none') return null;

    if (deliverTo === 'chat') {
      return this.deliverToChat(agentId, userId, content, triggeredBy, options);
    }

    const channel = messageDeliveryService.getAdapter(deliverTo);
    if (channel?.defaultDestination) {
      const destination = await channel.defaultDestination(agentId, userId);
      if (destination) {
        // Reuse the destination's own conversation thread, keyed by its
        // conversation id and hidden from web/CLI Recents.
        const { threadKey, ...route } = destination;
        const thread = await conversationService.getOrCreateThreadByExternalId(userId, agentId, threadKey);
        return messageDeliveryService.publish(userId, thread.id, content, triggeredBy, {
          ...options,
          channelContext: { channel: channel.name, ...route, threadId: thread.id },
        });
      }
      // No direct conversation or channel linked, so the channel cannot deliver.
      // Post to web chat only, so the message isn't silently lost and doesn't
      // reach the channels the target leaves out.
      logger.warn(
        "[Delivery] deliverTo:'%s' but no direct conversation or channel is linked — storing in the web thread instead",
        deliverTo,
      );
      return this.deliverToChat(agentId, userId, content, triggeredBy, options);
    }

    // 'all' — broadcast to every connected channel.
    return messageDeliveryService.publishToLatestThread(agentId, userId, content, triggeredBy, options);
  }

  /** Publish to web chat only, in the web-visible latest thread. */
  private async deliverToChat(
    agentId: string,
    userId: string,
    content: string,
    triggeredBy: TargetTrigger,
    options: TargetPublishOptions,
  ): Promise<ConversationMessage> {
    const thread = await conversationService.getOrCreateLatestThread(agentId, userId);
    return messageDeliveryService.publish(userId, thread.id, content, triggeredBy, {
      ...options,
      channelContext: { channel: 'websocket', threadId: thread.id },
    });
  }

  /**
   * Post to each chosen channel that is still linked to the agent, and return
   * the first stored message. Each post is stored in its channel's own thread.
   * A shared file belongs to one message, so files go with the first post
   * only: a run that shares files and posts to several channels is rare.
   * When no chosen channel is linked any more, the message goes to web chat
   * only, because the list excludes every other destination on that platform.
   */
  private async deliverToChosenChannels(
    agentId: string,
    userId: string,
    channel: ChannelName,
    linked: Set<string>,
    chosen: string[],
    content: string,
    triggeredBy: TargetTrigger,
    options: TargetPublishOptions,
  ): Promise<Delivery> {
    const reachable = chosen.filter((id) => linked.has(id));
    const chosenChannels = { channel, posted: reachable.length, skipped: chosen.length - reachable.length };
    if (chosenChannels.skipped > 0) {
      const unlinked = chosen.filter((id) => !linked.has(id));
      logger.warn(`[Delivery] Skipping ${channel} channels that are no longer linked: ${unlinked.join(', ')}`);
    }

    let first: ConversationMessage | null = null;
    for (const channelId of reachable) {
      const thread = await conversationService.getOrCreateThreadByExternalId(userId, agentId, channelId);
      const message = await messageDeliveryService.publish(userId, thread.id, content, triggeredBy, {
        ...options,
        channelContext: { channel, channelId, threadId: thread.id },
      });
      first ??= message;
    }
    if (first) return { message: first, chosenChannels };

    logger.warn(`[Delivery] None of the chosen ${channel} channels is linked — storing in the web thread instead`);
    return { message: await this.deliverToChat(agentId, userId, content, triggeredBy, options), chosenChannels };
  }
}

export const deliveryTargetService = new DeliveryTargetService();
