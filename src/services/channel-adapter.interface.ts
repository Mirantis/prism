/**
 * Channel Adapter Interface
 *
 * Defines the contract for message delivery channels (WebSocket, Slack, etc.)
 * All adapters implement this interface to enable unified message delivery
 * across multiple channels through the MessageDeliveryService.
 */

import { ConversationMessage } from '@prisma/client';

/**
 * Channel context for routing responses back to the originating channel
 */
export interface ChannelContext {
  channel: 'slack' | 'websocket' | 'teams';
  channelId?: string;
  /**
   * External thread identifier on the originating channel — Slack thread
   * timestamp, or Teams conversation id (which encodes the thread via
   * `;messageid=`).
   */
  threadTs?: string;
  /** Internal database thread ID */
  threadId: string;
  /**
   * When true, adapters that support interactive feedback (Slack, Teams)
   * render 👍/👎 buttons alongside this message. Caller gates
   * (terminal/length/cadence).
   */
  includeFeedback?: boolean;
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
  /**
   * Channel identifier (e.g., 'websocket', 'slack')
   */
  readonly name: string;

  /**
   * Deliver a message to a user via this channel
   *
   * Should be idempotent and handle errors gracefully.
   * If the user is not connected or delivery fails, the adapter should
   * log the error but not throw (the message is already persisted in DB).
   *
   * @param userId - The Lens Platform user ID
   * @param message - The message to deliver (already persisted in DB)
   * @param channelContext - Optional context for routing to specific channel/thread
   */
  deliver(userId: string, message: ConversationMessage, channelContext?: ChannelContext): Promise<void>;

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
   * - Set up any persistent connections (e.g., Slack Socket Mode)
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
