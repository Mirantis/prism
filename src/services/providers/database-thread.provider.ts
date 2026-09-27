/**
 * Database Thread Provider
 *
 * Reads conversation messages from PostgreSQL via Prisma.
 * This is the default provider for web chat threads (ThreadSource.DATABASE).
 */

import { ConversationMessage, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { ThreadMessageProvider, MessageReadOptions } from '../thread-provider.interface';

/**
 * The order rows are read in. A client's view breaks a tie on the timestamp by
 * id — the same rule every chat client applies to messages as they arrive live —
 * so two devices can never show the same moment in different orders. The model's
 * view keeps the order rows were written in, which a tie-break would change for
 * rows written in the same millisecond, and with it the prompt.
 */
function clientOrder(
  opts: MessageReadOptions | undefined,
  direction: 'asc' | 'desc',
):
  | Prisma.ConversationMessageOrderByWithRelationInput
  | Prisma.ConversationMessageOrderByWithRelationInput[] {
  return opts?.view === 'client'
    ? [{ createdAt: direction }, { id: direction }]
    : { createdAt: direction };
}

export class DatabaseThreadProvider implements ThreadMessageProvider {
  async getMessages(threadId: string, opts?: MessageReadOptions): Promise<ConversationMessage[]> {
    return prisma.conversationMessage.findMany({
      // See MessageView: the model view hides compacted rows (their content
      // lives in the thread's compaction summary) but keeps internal steps;
      // the client view keeps compacted rows but hides internal steps.
      where: {
        threadId,
        ...(opts?.view === 'client' ? { internalStep: false } : { isCompacted: false }),
      },
      orderBy: clientOrder(opts, 'asc'),
    });
  }

  async getRecentMessages(threadId: string, limit: number, opts?: MessageReadOptions): Promise<ConversationMessage[]> {
    // Same two views as getMessages. Filters live in the WHERE clause (not
    // post-fetch) so `take` yields `limit` *visible* rows — a long turn's
    // hidden steps must not crowd the window.
    const messages = await prisma.conversationMessage.findMany({
      where: {
        threadId,
        ...(opts?.view === 'client' ? { internalStep: false } : { isCompacted: false }),
      },
      orderBy: clientOrder(opts, 'desc'),
      take: limit,
    });
    return messages.reverse(); // Return in chronological order
  }
}
