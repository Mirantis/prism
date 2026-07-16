/**
 * Database Thread Provider
 *
 * Reads conversation messages from PostgreSQL via Prisma.
 * This is the default provider for web chat threads (ThreadSource.DATABASE).
 */

import { ConversationMessage } from '@prisma/client';
import prisma from '../../lib/prisma';
import { ThreadMessageProvider, MessageReadOptions } from '../thread-provider.interface';

export class DatabaseThreadProvider implements ThreadMessageProvider {
  async getMessages(threadId: string, opts?: MessageReadOptions): Promise<ConversationMessage[]> {
    return prisma.conversationMessage.findMany({
      where: {
        threadId,
        isCompacted: false,
        // Client view hides concise-mode internal steps; the model view keeps them.
        ...(opts?.excludeInternal ? { internalStep: false } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getRecentMessages(threadId: string, limit: number, opts?: MessageReadOptions): Promise<ConversationMessage[]> {
    // Filter internal steps in the WHERE clause (not post-fetch) so `take` yields
    // `limit` *visible* rows — a long turn's hidden steps must not crowd the window.
    const messages = await prisma.conversationMessage.findMany({
      where: {
        threadId,
        isCompacted: false,
        ...(opts?.excludeInternal ? { internalStep: false } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return messages.reverse(); // Return in chronological order
  }
}
