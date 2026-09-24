import { useQuery } from '@tanstack/react-query';
import { useAgent } from '@/lib/agent-context';
import { runtimeApi } from '@/api/runtime-client';

export function useRecentThreads() {
  const agent = useAgent();
  return useQuery({
    queryKey: ['threads', agent.agentId, 'recents'],
    queryFn: () =>
      runtimeApi.listThreads(agent.agentId, agent.userId, {
        threadSource: 'DATABASE',
        limit: 100,
      }),
  });
}
