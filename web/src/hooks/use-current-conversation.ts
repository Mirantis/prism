import { useParams, useRouterState } from '@tanstack/react-router';
import type { ConversationThread } from '@lensapp/prism-client';
import { useRecentThreads } from './use-recent-threads';
import { useThread } from './use-thread';

/**
 * The conversation on screen: the thread in the URL, or — at bare /chat — the latest one.
 * Undefined off the Chat page, and until the thread has loaded.
 */
export function useCurrentConversation(): ConversationThread | undefined {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { threadId } = useParams({ strict: false });
  const onChat = pathname.startsWith('/chat');

  // The routed thread's own query, the one the chat page reads, so the two share one
  // request and a conversation older than the Recents window still has its name.
  const { data: routed } = useThread(threadId, onChat);
  const { data: threads } = useRecentThreads({ enabled: onChat && !threadId });

  if (!onChat) return undefined;
  return threadId ? routed : threads?.[0];
}
