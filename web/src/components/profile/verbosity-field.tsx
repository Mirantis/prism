import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { runtimeApi } from '@/api/runtime-client';
import type { AgentDetails } from '@/types';

/**
 * Chat verbosity selector. Presents the underlying `verbose` boolean as two
 * named options — Concise (final result only) and Verbose (stream every step)
 * — since a labelled choice reads clearer than a bare toggle. Reads from the
 * page-level agent-details query and primes that cache from the PATCH
 * response, so no extra fetch is needed.
 */
export function VerbosityField({ verbose, agentId }: { verbose: boolean; agentId: string }) {
  const queryClient = useQueryClient();

  const mut = useMutation({
    mutationFn: (next: boolean) => runtimeApi.updateVerbose(next),
    onSuccess: ({ verbose: saved }) =>
      queryClient.setQueryData<AgentDetails>(
        ['agent-details', agentId],
        (old) => (old ? { ...old, verbose: saved } : old),
      ),
  });

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">Verbosity</span>
      <span className="inline-flex flex-wrap items-center gap-2 text-sm">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" disabled={mut.isPending}>
                {verbose ? 'Verbose' : 'Concise'}
                <ChevronDown className="size-4 opacity-60" />
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={verbose ? 'verbose' : 'concise'}
              onValueChange={(value) => mut.mutate(value === 'verbose')}
            >
              <DropdownMenuRadioItem value="concise">Concise</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="verbose">Verbose</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="text-muted-foreground">
          {verbose
            ? 'Streams every step of the agent’s working as it happens.'
            : 'Posts only the final result of each turn.'}
        </span>
      </span>
    </div>
  );
}
