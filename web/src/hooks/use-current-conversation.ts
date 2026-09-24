import { useQuery } from '@tanstack/react-query';
import { useParams, useRouterState } from '@tanstack/react-router';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import type { ConversationThread } from '@/types';
import { useRecentThreads } from './use-recent-threads';

/**
 * The conversation on screen: the thread in the URL, or — at bare /chat — the latest one.
 * Undefined off the Chat page, and until the thread has loaded.
 */
export function useCurrentConversation(): ConversationThread | undefined {
  const agent = useAgent();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { threadId } = useParams({ strict: false });
  const onChat = pathname.startsWith('/chat');

  // The routed thread's own query, under the key the chat page reads it by, so the two share
  // one request and a conversation older than the Recents window still has its name.
  const { data: routed } = useQuery({
    queryKey: ['thread', agent.agentId, threadId],
    queryFn: () => runtimeApi.getThread(agent.agentId, agent.userId, threadId!),
    enabled: onChat && Boolean(threadId),
  });
  const { data: threads } = useRecentThreads({ enabled: onChat && !threadId });

  if (!onChat) return undefined;
  return threadId ? routed : threads?.[0];
}
