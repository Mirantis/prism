/**
 * Channel Adapter Interface
 *
 * Defines the contract for message delivery channels. All adapters implement
 * this interface to enable unified message delivery across multiple channels
 * through the MessageDeliveryService. Shared code asks a channel for a
 * per-channel answer through the optional members here and never names the
 * channel itself.
 */

import { ConversationMessage } from '@prisma/client';
import { AttachmentMeta } from './attachment.service';

/** The chat platforms the runtime joins through their own apps. */
export const CHAT_PLATFORMS = ['slack', 'teams'] as const;

export type ChatPlatform = (typeof CHAT_PLATFORMS)[number];

/** Every channel: the runtime's own chat socket and each chat platform. One adapter each. */
export type ChannelName = 'websocket' | ChatPlatform;

export function isChatPlatform(value: unknown): value is ChatPlatform {
  return (CHAT_PLATFORMS as readonly unknown[]).includes(value);
}

/**
 * A persisted message plus the (no-bytes) metadata of any files the agent
 * shared with it. Each adapter renders these its own way.
 */
export type DeliverableMessage = ConversationMessage & {
  attachments?: AttachmentMeta[];
};

/**
 * Channel context for routing responses back to the originating channel
 */
export interface ChannelContext {
  /** The `name` of the adapter that delivers the message. */
  channel: ChannelName;
  /** The conversation inside the channel. Unset, the adapter picks the user's own. */
  channelId?: string;
  /** The channel's own thread to reply in. Unset, the reply posts top-level. */
  channelThreadId?: string;
  /** Internal database thread ID */
  threadId: string;
  /**
   * When true, adapters that support interactive feedback render 👍/👎
   * buttons alongside this message. Caller gates (terminal/length/cadence).
   */
  includeFeedback?: boolean;
}

/** Where a message goes inside a channel. */
export type ChannelDestination = Pick<ChannelContext, 'channelId' | 'channelThreadId'> & {
  /** The conversation a continuing turn posts in, as its system prompt names it. */
  channelLabel?: string;
};

/**
 * Interface for message delivery channels
 *
 * Each channel adapter is responsible for:
 * - Delivering messages to users via its specific protocol
 * - Tracking user connection status
 * - Handling initialization and shutdown
 */
export interface ChannelAdapter {
  /** Channel identifier, matched against `ChannelContext.channel`. */
  readonly name: ChannelName;

  /**
   * True when the channel shows the whole conversation — the person's own
   * messages and messages changed after they were published — rather than only
   * the agent's replies. Such a channel is handed those through
   * `messageDeliveryService.showInConversation`, and replaces a message it has
   * seen before.
   */
  readonly showsWholeConversation?: boolean;

  /**
   * Where an autonomous message continues a stored thread that started in this
   * channel: a scheduled task or a goal that resumes the conversation, or a
   * computer help request. `originChannelId` is the conversation the thread
   * recorded when it began, when it recorded one. A resolved conversation
   * gets a `channelLabel` that names it by its id, which puts the channel
   * guidelines in the prompt of a turn that continues the thread.
   */
  threadDestination?(threadId: string, originChannelId?: string): Promise<ChannelDestination>;

  /**
   * The conversation a message addressed to this channel as a whole goes to:
   * the user's direct conversation, else the agent's main channel. `threadKey`
   * keys the stored thread that holds such messages. Null when the user has
   * linked neither.
   */
  defaultDestination?(
    agentId: string,
    userId: string,
  ): Promise<(ChannelDestination & { threadKey: string }) | null>;

  /**
   * Deliver a message to a user via this channel
   *
   * Should be idempotent and handle errors gracefully.
   * If the user is not connected or delivery fails, the adapter should
   * log the error but not throw (the message is already persisted in DB).
   *
   * @param userId - The Lens Platform user ID
   * @param message - The message to deliver (already persisted in DB), with
   *   optional shared-file metadata in `attachments`
   * @param channelContext - Optional context for routing to specific channel/thread
   */
  deliver(userId: string, message: DeliverableMessage, channelContext?: ChannelContext): Promise<void>;

  /**
   * Check if user has an active connection on this channel
   *
   * @param userId - The Lens Platform user ID
   * @returns true if user can receive messages on this channel
   */
  isUserConnected(userId: string): Promise<boolean>;

  /**
   * Initialize the channel adapter
   *
   * Called once on server startup. Adapters should:
   * - Set up any persistent connections
   * - Load existing connection state from database
   * - Register event handlers
   */
  initialize(): Promise<void>;

  /**
   * Shutdown the channel adapter
   *
   * Called on SIGTERM/SIGINT. Adapters should:
   * - Close all connections gracefully
   * - Clean up any resources
   */
  shutdown(): Promise<void>;
}
