import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAgent } from '@/lib/agent-context';

const MODEL_ID_PATTERN = /^[A-Za-z0-9._:\-/]+$/;
const MODEL_ID_MAX_LEN = 200;

/**
 * Editable model-ID field. Used for the main agent model and for the
 * heartbeat/cron overrides. When `allowEmpty` is set the field may be cleared
 * to fall back to the main model; the resolved fallback is shown as a hint via
 * the `effective` value returned by the loader.
 */
export function ModelField({
  label,
  queryKey,
  load,
  save,
  allowEmpty = false,
  affects = [],
}: {
  label: string;
  queryKey: string;
  load: () => Promise<{ model: string | null; effective?: string }>;
  save: (model: string | null) => Promise<{ model: string | null; effective?: string }>;
  allowEmpty?: boolean;
  /**
   * Other model-field query keys whose resolved `effective` depends on this
   * one (the heartbeat/cron fields fall back to the main model), so they get
   * invalidated when this field changes.
   */
  affects?: string[];
}) {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: modelInfo } = useQuery({
    queryKey: [queryKey, agent.agentId],
    queryFn: load,
  });

  // Raw override ('' when unset) and the model this scope actually resolves to.
  const override = modelInfo?.model ?? '';
  const effective = modelInfo?.effective;

  const updateMut = useMutation({
    mutationFn: (next: string | null) => save(next),
    onSuccess: (data) => {
      queryClient.setQueryData([queryKey, agent.agentId], data);
      queryClient.invalidateQueries({ queryKey: ['agent-details', agent.agentId] });
      // Dependent fields (heartbeat/cron) resolve `effective` off this model,
      // so refresh them too.
      for (const key of affects) {
        queryClient.invalidateQueries({ queryKey: [key, agent.agentId] });
      }
      setEditing(false);
      setError(null);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Update failed'),
  });

  const trimmed = value.trim();
  const next = trimmed.length === 0 ? null : trimmed;
  const valid =
    (allowEmpty && trimmed.length === 0) ||
    (trimmed.length > 0 && trimmed.length <= MODEL_ID_MAX_LEN && MODEL_ID_PATTERN.test(trimmed));
  const unchanged = (next ?? '') === override;
  const canSave = valid && !updateMut.isPending && !unchanged;

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {editing ? (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSave) {
                updateMut.mutate(next);
              } else if (e.key === 'Escape') {
                setEditing(false);
                setError(null);
              }
            }}
            maxLength={MODEL_ID_MAX_LEN}
            placeholder={allowEmpty ? 'Empty → use main model' : undefined}
            className="h-7 w-[360px] px-2 py-1 text-sm"
            aria-label={`${label} ID`}
            autoFocus
          />
          <Button size="sm" onClick={() => updateMut.mutate(next)} disabled={!canSave}>
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => updateMut.mutate(null)}
            disabled={updateMut.isPending}
          >
            Reset
          </Button>
          {allowEmpty && (
            <span className="basis-full text-xs text-muted-foreground">
              Leave empty to use the main agent model.
            </span>
          )}
          {!valid && value.length > 0 && (
            <span className="basis-full text-xs text-destructive">
              Use 1–{MODEL_ID_MAX_LEN} chars: letters, digits, and ._:-/ only.
            </span>
          )}
          {error && <span className="basis-full text-xs text-destructive">{error}</span>}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-sm">
          {override ? (
            override
          ) : allowEmpty ? (
            <span className="text-muted-foreground">
              Default{effective ? ` — uses ${effective}` : ''}
            </span>
          ) : (
            override || <span className="text-muted-foreground">Loading…</span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              setValue(override);
              setError(null);
              setEditing(true);
            }}
            disabled={!modelInfo}
            aria-label={`Edit ${label.toLowerCase()}`}
          >
            <Pencil className="size-3" />
          </Button>
        </span>
      )}
    </div>
  );
}
