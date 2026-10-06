import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import type { AgentDetails } from '@lensapp/prism-client';

export function LockedInField({ details }: { details: AgentDetails }) {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (lockedIn: boolean) => runtimeApi.updateLockedIn(lockedIn),
    onMutate: async (lockedIn) => {
      await queryClient.cancelQueries({ queryKey: ['agent-details', agent.agentId] });
      queryClient.setQueryData(['agent-details', agent.agentId], (old: AgentDetails | undefined) =>
        old ? { ...old, lockedIn } : old,
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
      <span className="text-xs text-muted-foreground">Locked-in mode</span>
      {/* Not a <label> wrapper: Base UI points the switch's aria-labelledby at
          an enclosing label, and aria-labelledby overrides aria-label — so the
          accessible name would become the adjacent state text ("Unlocked")
          instead of "Locked-in mode". The text beside it is a state readout,
          not a name. */}
      <div className="inline-flex items-center gap-2 text-sm">
        <Switch
          checked={details.lockedIn}
          onCheckedChange={(checked) => mutation.mutate(checked)}
          disabled={mutation.isPending}
          aria-label="Locked-in mode"
        />
        <span>{details.lockedIn ? 'Locked' : 'Unlocked'}</span>
      </div>
      <span className="text-xs text-muted-foreground">
        While locked, the agent's own tools can't rewrite Soul, User, Memory, Vision, Heartbeat
        or Bootstrap, and can't add or delete long-term memories — and it can't unlock itself.
        Settings, renames and memory search still work. First-run onboarding is paused while
        this is on, and runs when you unlock the agent.
      </span>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
