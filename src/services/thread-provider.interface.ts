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

/**
 * Read options shared by both providers.
 *
 * The default (option absent) is the **model-fidelity** view: every persisted
 * step is returned, so the LLM replays the full turn. `excludeInternal` switches
 * to the **client** view, which drops concise-mode intermediate steps. The
 * mechanics differ per provider for the same semantic:
 * - DatabaseThreadProvider: filters `internalStep` rows out of the query.
 * - SlackThreadProvider: does NOT merge the persisted internal rows into the
 *   Slack-derived replay (they were never posted to Slack).
 */
export interface MessageReadOptions {
  /** Drop concise-mode internal steps (client history view). Default: keep them. */
  excludeInternal?: boolean;
}

export interface ThreadMessageProvider {
  /**
   * Get all non-compacted messages for a thread, in chronological order.
   */
  getMessages(threadId: string, opts?: MessageReadOptions): Promise<ConversationMessage[]>;

  /**
   * Get the most recent non-compacted messages for a thread, in chronological order.
   */
  getRecentMessages(threadId: string, limit: number, opts?: MessageReadOptions): Promise<ConversationMessage[]>;
}
