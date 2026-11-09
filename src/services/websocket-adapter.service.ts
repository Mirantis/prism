/**
 * WebSocket Adapter Service (Agent-Runtime)
 *
 * Implements ChannelAdapter for the chat socket. A message becomes a `message`
 * event on the numbered stream, which every connected client reads and a client
 * that was away is sent again when it resumes.
 */

import type { ConversationMessage } from '@prisma/client';
import { ChannelAdapter, ChannelContext, ChannelDestination, DeliverableMessage } from './channel-adapter.interface';
import { eventStreamService } from './event-stream.service';
import { inboundMessageService } from './inbound-message.service';
import { webChatLabel } from './web-chat-label';
import type { MessageEventPayload } from '../protocol/chat-protocol';
import { agentMessageKind } from '../lib/agent-message-kind';
import type { ResumedReply } from '../types';
import { logger } from '../logger';

/** The wire form of a stored message, for any role. */
export function messageEventPayload(message: DeliverableMessage): MessageEventPayload {
  // Handle createdAt as both Date and string since it crosses HTTP boundary
  const createdAt = message.createdAt instanceof Date
    ? message.createdAt.toISOString()
    : String(message.createdAt);
  return {
    id: message.id,
    threadId: message.threadId,
    role: message.role,
    content: message.content,
    triggeredBy: message.triggeredBy,
    toolCalls: (message.toolCalls as unknown[] | null) ?? null,
    blocks: (message.blocks as unknown[] | null) ?? null,
    isCompacted: message.isCompacted,
    step: message.step,
    createdAt,
    // Shared-file metadata (no bytes); clients render download chips and
    // fetch bytes from GET /agents/attachments/:id.
    attachments: (message.attachments as MessageEventPayload['attachments']) ?? null,
    senderId: message.senderExternalId ?? null,
    senderName: message.senderName ?? null,
    agentMessageKind: agentMessageKind(message),
  };
}

class WebSocketAdapterService implements ChannelAdapter {
  readonly name = 'websocket';
  readonly showsWholeConversation = true;
  readonly opensWebUiLinks = true;

  async deliver(userId: string, message: DeliverableMessage, _channelContext?: ChannelContext): Promise<void> {
    try {
      eventStreamService.publish({ type: 'message', payload: messageEventPayload(message) });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('WebSocket deliver failed for user %s: %s', userId, msg);
    }
  }

  /**
   * Always connected. The stream keeps what it is given for a client that is
   * away right now, which is exactly the case this used to answer "no" for — and
   * a reply that was never published could never be sent again.
   */
  async isUserConnected(_userId: string): Promise<boolean> {
    return true;
  }

  /** A turn that continues a web conversation gets the label a chat turn on it gets. */
  async threadDestination(threadId: string): Promise<ChannelDestination> {
    return { channelLabel: await webChatLabel(threadId) };
  }

  /** The socket answers one message at a time, so a resumed reply waits its turn there. */
  continueReply(message: ConversationMessage, resumed: ResumedReply): void {
    inboundMessageService.resume(message, resumed);
  }

  async initialize(): Promise<void> {
    logger.info('WebSocket adapter ready');
  }

  async shutdown(): Promise<void> {
    logger.info('WebSocket adapter shutdown');
  }
}

// Export singleton instance
export const webSocketAdapterService = new WebSocketAdapterService();
