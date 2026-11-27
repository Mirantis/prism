import { useQuery } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';

const WINDOW_HOURS = 24;

/** Token spend over the last 24 hours. Every reader shares the query, so the page reads the window once. */
export function useLlmUsage() {
  const agent = useAgent();
  return useQuery({
    queryKey: ['llm-usage', agent.agentId, WINDOW_HOURS],
    queryFn: () => runtimeApi.llmUsage(WINDOW_HOURS),
    refetchInterval: 30_000,
  });
}
