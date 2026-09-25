import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
import { useWebSocket } from '@/hooks/use-websocket';
import { useAgent } from '@/lib/agent-context';
import { agentStatusTone, TONE_DOT } from '@/lib/tones';
import { cn } from '@/lib/utils';

const LABELS: Record<string, string> = {
  RUNNING: 'Working',
  IDLE: 'Idle',
  ERROR: 'Error',
};

/**
 * A presence dot on the corner of the agent's mark: what it is doing right now, on every page.
 * Work on a thread is reported the moment the socket says the thread is working. The poll covers
 * work the socket does not announce, such as a run while the user has no web thread, and the poll
 * is refreshed when the work ends so the dot does not keep an old reading for the rest of the
 * interval.
 */
export function AgentPresence({ className }: { className?: string }) {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const { isAgentBusy } = useWebSocket();
  const { data: details } = useQuery({
    queryKey: ['agent-details', agent.agentId],
    queryFn: () => runtimeApi.details(),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (isAgentBusy) return;
    void queryClient.invalidateQueries({ queryKey: ['agent-details', agent.agentId] });
  }, [isAgentBusy, queryClient, agent.agentId]);

  const status = isAgentBusy ? 'RUNNING' : details?.status;
  if (!status) return null;

  const tone = agentStatusTone(status);
  const label = LABELS[status] ?? status;
  return (
    <span
      role="img"
      aria-label={`Agent status: ${label}`}
      title={label}
      data-testid="agent-presence"
      data-status={status}
      className={cn('absolute flex size-3 items-center justify-center', className)}
    >
      {status === 'RUNNING' && (
        <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', TONE_DOT[tone])} />
      )}
      <span className={cn('relative inline-flex size-2.5 rounded-full ring-2 ring-sidebar', TONE_DOT[tone])} />
    </span>
  );
}
