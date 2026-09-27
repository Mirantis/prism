import { useQuery } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';

/** How many conversations Recents and the command palette reach back over. */
export const RECENT_THREADS_LIMIT = 300;

export function recentThreadsQueryKey(agentId: string) {
  return ['threads', agentId, 'recents'] as const;
}

/**
 * The agent's newest conversations. Database threads only; Slack threads are filtered out
 * server-side. Every reader shares one cache entry, which the chat socket keeps current.
 */
export function useRecentThreads({ enabled = true }: { enabled?: boolean } = {}) {
  const agent = useAgent();
  return useQuery({
    queryKey: recentThreadsQueryKey(agent.agentId),
    queryFn: () =>
      runtimeApi.listThreads(agent.agentId, agent.userId, {
        threadSource: 'DATABASE',
        limit: RECENT_THREADS_LIMIT,
      }),
    enabled,
  });
}
