/**
 * Thread Message Provider Interface
 *
 * Abstracts how conversation messages are read from different sources.
 * Write operations (addMessage, compaction) remain DB-only.
 * Thread metadata (CRUD, listing) remains DB-only.
 *
 * Two implementations:
 * - DatabaseThreadProvider: reads from PostgreSQL (web chat, default)
 * - SlackThreadProvider: reads from Slack conversations.replies API (channel threads)
 */

import { ConversationMessage } from '@prisma/client';

export interface ThreadMessageProvider {
  /**
   * Get all non-compacted messages for a thread, in chronological order.
   */
  getMessages(threadId: string): Promise<ConversationMessage[]>;

  /**
   * Get the most recent non-compacted messages for a thread, in chronological order.
   */
  getRecentMessages(threadId: string, limit: number): Promise<ConversationMessage[]>;
}
