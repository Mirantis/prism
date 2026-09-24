import { useParams, useRouterState } from '@tanstack/react-router';
import type { ConversationThread } from '@/types';
import { useRecentThreads } from './use-recent-threads';

/**
 * The conversation on screen: the thread in the URL, or — at bare /chat — the latest one.
 * Undefined off the Chat page, and until the thread list has loaded.
 */
export function useCurrentConversation(): ConversationThread | undefined {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { threadId } = useParams({ strict: false });
  const onChat = pathname.startsWith('/chat');
  const { data: threads } = useRecentThreads({ enabled: onChat });
  if (!onChat) return undefined;
  return threadId ? threads?.find((t) => t.id === threadId) : threads?.[0];
}
