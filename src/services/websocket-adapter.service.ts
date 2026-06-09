/**
 * WebSocket Adapter Service (Agent-Runtime)
 *
 * Implements ChannelAdapter for WebSocket message delivery.
 * Calls the local WebSocket gateway directly (no HTTP round-trip).
 */

import { ConversationMessage } from '@prisma/client';
import { ChannelAdapter, ChannelContext } from './channel-adapter.interface';
import { webSocketGatewayService } from './websocket-gateway.service';
import { logger } from '../logger';

// ============================================================================
// WebSocket Adapter
// ============================================================================

class WebSocketAdapterService implements ChannelAdapter {
  readonly name = 'websocket';

  async deliver(userId: string, message: ConversationMessage, _channelContext?: ChannelContext): Promise<void> {
    try {
      // Handle createdAt as both Date and string since it crosses HTTP boundary
      const createdAt = message.createdAt instanceof Date
        ? message.createdAt.toISOString()
        : String(message.createdAt);

      webSocketGatewayService.broadcast(userId, {
        type: 'chat',
        payload: {
          id: message.id,
          threadId: message.threadId,
          role: message.role,
          content: message.content,
          triggeredBy: message.triggeredBy,
          toolCalls: message.toolCalls,
          blocks: message.blocks,
          tokenCount: message.tokenCount,
          isCompacted: message.isCompacted,
          createdAt,
        },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('WebSocket deliver failed for user %s: %s', userId, msg);
    }
  }

  async setTyping(userId: string, active: boolean, _channelContext?: ChannelContext): Promise<void> {
    // The frontend (`use-websocket.ts`) toggles its ChatTypingIndicator on
    // this message and also clears it when a 'chat' message arrives.
    webSocketGatewayService.broadcast(userId, {
      type: 'typing',
      payload: { isTyping: active },
    });
  }

  async isUserConnected(userId: string): Promise<boolean> {
    return webSocketGatewayService.isConnected(userId);
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
