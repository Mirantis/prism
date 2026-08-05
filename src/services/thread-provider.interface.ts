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
 * Which projection of a thread a read returns.
 *
 * - `'model'` (the default): what the LLM replays. Every persisted step is
 *   returned — concise-mode internal steps included — but compacted history is
 *   hidden, since its content lives in the thread's compaction summary.
 * - `'client'`: what users scroll. Compacted rows stay visible (compaction
 *   only changes what the model sees) while concise-mode internal steps are
 *   dropped.
 *
 * The mechanics differ per provider for the same semantic:
 * - DatabaseThreadProvider: WHERE-clause filters on `isCompacted` (model view)
 *   vs `internalStep` (client view).
 * - SlackThreadProvider: the model view fetches only replies after the
 *   thread's `compactedThroughTs` watermark (row flags can't hide live-read
 *   Slack messages); the client view does NOT merge the persisted internal
 *   rows into the Slack-derived replay (they were never posted to Slack).
 */
export type MessageView = 'model' | 'client';

/** Read options shared by both providers. */
export interface MessageReadOptions {
  /** Which projection to read; see {@link MessageView}. Default: `'model'`. */
  view?: MessageView;
}

export interface ThreadMessageProvider {
  /**
   * Get a thread's messages in chronological order (see MessageReadOptions for
   * which view).
   */
  getMessages(threadId: string, opts?: MessageReadOptions): Promise<ConversationMessage[]>;

  /**
   * Get the most recent messages for a thread, in chronological order (see
   * MessageReadOptions for which view).
   */
  getRecentMessages(threadId: string, limit: number, opts?: MessageReadOptions): Promise<ConversationMessage[]>;
}
