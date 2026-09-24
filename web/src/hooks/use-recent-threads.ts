import { useQuery } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';

/** How many conversations Recents and the command palette reach back over. */
export const RECENT_THREADS_LIMIT = 300;

/**
 * The agent's newest conversations. Database threads only; Slack threads are filtered out
 * server-side. Every reader shares one cache entry, which a new or retitled thread invalidates.
 */
export function useRecentThreads({ enabled = true }: { enabled?: boolean } = {}) {
  const agent = useAgent();
  return useQuery({
    queryKey: ['threads', agent.agentId, 'recents'],
    queryFn: () =>
      runtimeApi.listThreads(agent.agentId, agent.userId, {
        threadSource: 'DATABASE',
        limit: RECENT_THREADS_LIMIT,
      }),
    enabled,
  });
}
