import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import type { AgentDetails } from '@/types';

/**
 * The Agent tab of the Profile page: the one identity document the user edits
 * here. The others are read-only viewers because the agent maintains them
 * through conversation; nothing writes this one but the user.
 */
export function AgentGuideEditor({ details }: { details: AgentDetails }) {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const stored = details.agentMd ?? '';
  const [draft, setDraft] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  // What the last accepted save wrote, so "Saved" shows only while the box
  // still holds that text — an edit right after saving is unsaved again.
  const savedRef = useRef<string | null>(null);

  // Adopt the stored document when it changes underneath an untouched box (a
  // refetch, or an edit from another client). Compared against the previous
  // stored value, since a clean draft equals that one and not the new one. A
  // touched box keeps its draft: dropping what someone is typing is worse than
  // editing from a stale base.
  const prevStored = useRef(stored);
  if (prevStored.current !== stored) {
    const wasClean = draft === prevStored.current;
    prevStored.current = stored;
    if (wasClean) setDraft(stored);
  }

  const mutation = useMutation({
    mutationFn: (next: string) => runtimeApi.updateAgentGuide(next),
    onMutate: () => setError(null),
    onSuccess: (res) => {
      savedRef.current = res.agentMd;
      queryClient.setQueryData(['agent-details', agent.agentId], (old: AgentDetails | undefined) =>
        old ? { ...old, agentMd: res.agentMd } : old,
      );
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Save failed'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-details', agent.agentId] });
    },
  });

  const dirty = draft !== stored;
  const justSaved = !dirty && savedRef.current === draft;

  return (
    <div className="mt-3 flex flex-col gap-2">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Agent guide"
        spellCheck={false}
        className="h-64 resize-y font-mono text-xs"
      />
      <div className="flex items-center gap-2">
        <Button onClick={() => mutation.mutate(draft)} disabled={!dirty || mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setDraft(stored)}
          disabled={!dirty || mutation.isPending}
        >
          Revert
        </Button>
        {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
        {justSaved && <span className="text-xs text-muted-foreground">Saved</span>}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
      <span className="text-xs text-muted-foreground">
        The agent's operating manual — how it works, when to reach out, safety norms, channel
        etiquette. It reaches the agent on its next turn. This document is yours: the agent has no
        tool to change it.
      </span>
    </div>
  );
}
