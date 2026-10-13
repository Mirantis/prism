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
import type { ResumedReply } from '../types';

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
 * A conversation linked to the agent that the agent may post into on its own
 * initiative: a linked channel, or a linked DM.
 */
export interface LinkedTarget {
  /** `<platform>:<conversation id>`, the name the agent sends to. */
  key: string;
  /** The `name` of the adapter that lists and posts to it. */
  platform: ChatPlatform;
  kind: 'channel' | 'dm';
  conversationId: string;
  name: string | null;
  isMain: boolean;
  /** For a DM, the user it is linked to. */
  dmUserId?: string;
}

/**
 * A send the runtime refuses. The message is the reason the agent reads, so it
 * names the rule and, for a mention, the person.
 */
export class SendRefusedError extends Error {
  constructor(
    message: string,
    /** Telemetry-safe reason code. */
    readonly code: string,
  ) {
    super(message);
    this.name = 'SendRefusedError';
  }
}

/**
 * The `<@ID>` and `<@ID:Name>` mention tokens the agent writes. Global, so use
 * it with `matchAll` and `replace` only.
 */
export const MENTION_TOKEN = /<@([^>:]*)(?::([^>]*))?>/g;

/** How a refusal names a target to the agent. */
export function describeTarget(target: LinkedTarget): string {
  if (target.kind === 'dm') return target.name ? `the DM with ${target.name}` : 'the DM';
  return target.name ? `#${target.name}` : target.key;
}

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
   * Continue a reply a restart interrupted, for a channel that answers its
   * messages in a queue of its own. `message` is the newest message the reply
   * owes an answer. A channel without it starts the reply's turn at once.
   */
  continueReply?(message: ConversationMessage, resumed: ResumedReply): void;

  /** The ids of the agent's linked shared channels, which a webhook or a scheduled task can choose to post to. */
  linkedChannelIds?(agentId: string): Promise<string[]>;

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
   * The platform's name as the agent reads it in a message, for example in a
   * failed send. An adapter that posts to targets sets it.
   */
  readonly displayName?: string;

  /** The agent's linked channels and DMs on this platform. */
  listLinkedTargets?(agentId: string): Promise<LinkedTarget[]>;

  /**
   * Post agent-written text into a linked target, in the reply chain rooted at
   * `thread` when given. Every `<@ID>` token must name a member of the target,
   * and becomes a mention that notifies. Throws `SendRefusedError` for a send
   * the platform rules refuse, and the platform's error when the post fails.
   * Returns the id of the posted message.
   */
  postToTarget?(target: LinkedTarget, text: string, thread?: string): Promise<{ messageId: string }>;

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
