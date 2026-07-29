import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import type { AgentDetails } from '@/types';

export function VerbosityField({ details }: { details: AgentDetails }) {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (verbose: boolean) => runtimeApi.updateVerbose(verbose),
    onMutate: async (verbose) => {
      await queryClient.cancelQueries({ queryKey: ['agent-details', agent.agentId] });
      queryClient.setQueryData(['agent-details', agent.agentId], (old: AgentDetails | undefined) =>
        old ? { ...old, verbose } : old,
      );
      setError(null);
    },
    onError: (e: unknown) => {
      queryClient.invalidateQueries({ queryKey: ['agent-details', agent.agentId] });
      setError(e instanceof Error ? e.message : 'Update failed');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-details', agent.agentId] });
    },
  });

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">Chat delivery</span>
      {/* Not a <label> wrapper: Base UI points the switch's aria-labelledby at
          an enclosing label, and aria-labelledby overrides aria-label — the
          accessible name would become the adjacent state text ("Concise") in-
          stead of "Verbose delivery". The text beside it is a state readout,
          not a name. */}
      <div className="inline-flex items-center gap-2 text-sm">
        <Switch
          checked={details.verbose}
          onCheckedChange={(checked) => mutation.mutate(checked)}
          disabled={mutation.isPending}
          aria-label="Verbose delivery"
        />
        <span>{details.verbose ? 'Verbose' : 'Concise'}</span>
      </div>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
