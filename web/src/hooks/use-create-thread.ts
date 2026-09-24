import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';

/**
 * Start a fresh conversation and open it. The server reuses the newest thread while it is
 * still empty, so pressing twice does not stack empty threads.
 */
export function useCreateThread() {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: () => runtimeApi.createThread(agent.agentId, agent.userId),
    onSuccess: (thread) => {
      queryClient.invalidateQueries({ queryKey: ['threads', agent.agentId, 'recents'] });
      queryClient.invalidateQueries({ queryKey: ['threads', agent.agentId, 'latest'] });
      navigate({ to: '/chat/$threadId', params: { threadId: thread.id } });
    },
  });

  // Said in words, or the press is a silent no-op that reads as a dead button.
  const error = mutation.error
    ? mutation.error instanceof Error
      ? mutation.error.message
      : 'Could not start a conversation'
    : null;

  return { create: () => mutation.mutate(), isPending: mutation.isPending, error };
}
