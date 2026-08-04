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
 * The default (option absent) is the **model** view: every persisted step is
 * returned so the LLM replays the full turn, but compacted history is hidden —
 * its content lives in the thread's compaction summary. `excludeInternal`
 * switches to the **client** view: compacted rows stay visible (users scroll
 * the full thread; compaction only changes what the model sees) while
 * concise-mode intermediate steps are dropped. The mechanics differ per
 * provider for the same semantic:
 * - DatabaseThreadProvider: WHERE-clause filters on `isCompacted` (model view)
 *   vs `internalStep` (client view).
 * - SlackThreadProvider: the model view fetches only replies after the
 *   thread's `compactedThroughTs` watermark (row flags can't hide live-read
 *   Slack messages); the client view does NOT merge the persisted internal
 *   rows into the Slack-derived replay (they were never posted to Slack).
 */
export interface MessageReadOptions {
  /** Drop concise-mode internal steps (client history view). Default: keep them. */
  excludeInternal?: boolean;
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
