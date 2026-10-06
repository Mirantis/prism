import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import type { AgentDetails, DocumentField } from '@lensapp/prism-client';

/**
 * One identity document on the Profile page. Every tab renders this: the user
 * edits any of the seven, and the agent keeps its own tools for the six it
 * maintains through conversation.
 */
export function DocumentEditor({
  field,
  label,
  details,
  onDirtyChange,
}: {
  field: DocumentField;
  label: string;
  details: AgentDetails;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const stored = details[field] ?? '';
  const [draft, setDraft] = useState(stored);
  const [reason, setReason] = useState('');
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
    mutationFn: (next: string) => runtimeApi.updateWorkspaceDoc(field, next, reason.trim()),
    onMutate: () => setError(null),
    onSuccess: (res) => {
      savedRef.current = res.content;
      setReason('');
      queryClient.setQueryData(['agent-details', agent.agentId], (old: AgentDetails | undefined) =>
        old ? { ...old, [field]: res.content } : old,
      );
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Save failed'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-details', agent.agentId] });
      queryClient.invalidateQueries({ queryKey: ['document-revisions', field] });
    },
  });

  const dirty = draft !== stored;
  const justSaved = !dirty && savedRef.current === draft;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  return (
    <div className="flex flex-col gap-3">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={`${label} document`}
        spellCheck={false}
        className="h-72 resize-y bg-background/40 p-4 font-mono text-sm leading-6"
      />
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        aria-label="What changed (optional)"
        placeholder="What changed (optional)"
        maxLength={200}
        className="h-9 text-sm"
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
      <span className="text-xs text-foreground/70">
        Your changes take effect on the agent's next turn. Each save keeps a version in history.
      </span>
    </div>
  );
}
