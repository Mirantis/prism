import { ThreadSource, type Prisma } from '@prisma/client';

/**
 * A conversation started in the web UI or the terminal. A channel's threads all hold an
 * external id and are read in the channel, so a client never opens one.
 */
export const WEB_THREAD = {
  threadSource: ThreadSource.DATABASE,
  externalThreadId: null,
} satisfies Prisma.ConversationThreadWhereInput;

/** Whether a thread read from the database is a web thread, by the rule of `WEB_THREAD`. */
export function isWebThread(thread: { threadSource: ThreadSource; externalThreadId: string | null }): boolean {
  return thread.threadSource === WEB_THREAD.threadSource && thread.externalThreadId === WEB_THREAD.externalThreadId;
}
