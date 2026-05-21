/**
 * Database Thread Provider
 *
 * Reads conversation messages from PostgreSQL via Prisma.
 * This is the default provider for web chat threads (ThreadSource.DATABASE).
 */

import { ConversationMessage } from '@prisma/client';
import prisma from '../../lib/prisma';
import { ThreadMessageProvider } from '../thread-provider.interface';

export class DatabaseThreadProvider implements ThreadMessageProvider {
  async getMessages(threadId: string): Promise<ConversationMessage[]> {
    return prisma.conversationMessage.findMany({
      where: {
        threadId,
        isCompacted: false,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getRecentMessages(threadId: string, limit: number): Promise<ConversationMessage[]> {
    const messages = await prisma.conversationMessage.findMany({
      where: {
        threadId,
        isCompacted: false,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return messages.reverse(); // Return in chronological order
  }
}
