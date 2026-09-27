import { useQuery } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { useChatConnection } from '@/lib/chat-socket/chat-connection-context';

export function threadQueryKey(agentId: string, threadId: string | undefined) {
  return ['thread', agentId, threadId] as const;
}

/**
 * One conversation with its history. The chat socket's events are held while it loads
 * and applied to the result, so a message that arrives during the request is kept.
 */
export function useThread(threadId: string | undefined, enabled = true) {
  const agent = useAgent();
  const connection = useChatConnection();
  return useQuery({
    queryKey: threadQueryKey(agent.agentId, threadId),
    queryFn: () => connection.holdEvents(runtimeApi.getThread(agent.agentId, agent.userId, threadId!)),
    enabled: enabled && Boolean(threadId),
  });
}
