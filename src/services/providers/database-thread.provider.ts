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
      // Two views on purpose: the model view hides compacted rows (their
      // content lives in the thread's compaction summary) but keeps internal
      // steps; the client view keeps compacted rows (users scroll the full
      // thread — compaction only changes what the model sees) but hides
      // concise-mode internal steps.
      where: {
        threadId,
        ...(opts?.excludeInternal ? { internalStep: false } : { isCompacted: false }),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getRecentMessages(threadId: string, limit: number, opts?: MessageReadOptions): Promise<ConversationMessage[]> {
    // Same two views as getMessages. Filters live in the WHERE clause (not
    // post-fetch) so `take` yields `limit` *visible* rows — a long turn's
    // hidden steps must not crowd the window.
    const messages = await prisma.conversationMessage.findMany({
      where: {
        threadId,
        ...(opts?.excludeInternal ? { internalStep: false } : { isCompacted: false }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return messages.reverse(); // Return in chronological order
  }
}
