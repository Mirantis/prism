import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAgent } from '@/lib/agent-context';

const MODEL_ID_PATTERN = /^[A-Za-z0-9._:\-/]+$/;
const MODEL_ID_MAX_LEN = 200;

/**
 * One model setting as a list row: the label and what the model is for on the
 * left, the model ID and its edit control on the right. When `allowEmpty` is set
 * the field may be cleared; the loader's `effective` value then shows what an
 * empty field falls back to.
 */
export function ModelField({
  label,
  description,
  tag,
  queryKey,
  load,
  save,
  allowEmpty = false,
  emptyLabel = 'Not set',
  fallbackLabel = (model: string) => `Uses ${model}`,
  affects = [],
}: {
  label: string;
  /** What this model is used for, under the label. */
  description?: string;
  /** A short marker beside the label, such as "Required". */
  tag?: { text: string; tone: 'muted' | 'attention' };
  queryKey: string;
  load: () => Promise<{ model: string | null; effective?: string }>;
  save: (model: string | null) => Promise<{ model: string | null; effective?: string }>;
  allowEmpty?: boolean;
  /** Shown when the field and its fallback are both empty. */
  emptyLabel?: string;
  /** Shown when the field is empty and falls back to another model. */
  fallbackLabel?: (model: string) => string;
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

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 sm:max-w-[45%]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          {tag && (
            <Badge
              variant={tag.tone === 'attention' ? 'secondary' : 'outline'}
              className={tag.tone === 'attention' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}
            >
              {tag.text}
            </Badge>
          )}
        </div>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>

      {editing ? (
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-[55%]">
          <div className="flex items-center gap-2">
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave) updateMut.mutate(next);
                else if (e.key === 'Escape') cancel();
              }}
              maxLength={MODEL_ID_MAX_LEN}
              placeholder={allowEmpty && effective ? fallbackLabel(effective) : 'Model ID'}
              className="h-8 min-w-0 flex-1 font-mono text-xs"
              aria-label={`${label} ID`}
              autoFocus
            />
            <Button size="sm" onClick={() => updateMut.mutate(next)} disabled={!canSave}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
          {override && (
            <button
              type="button"
              className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
              onClick={() => updateMut.mutate(null)}
              disabled={updateMut.isPending}
            >
              {allowEmpty ? 'Clear' : 'Reset to default'}
            </button>
          )}
          {!valid && value.length > 0 && (
            <span className="text-xs text-destructive">
              Use 1–{MODEL_ID_MAX_LEN} chars: letters, digits, and ._:-/ only.
            </span>
          )}
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-1 sm:justify-end">
          {!modelInfo ? (
            <span className="text-sm text-muted-foreground">Loading…</span>
          ) : override ? (
            <code title={override} className="truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs">
              {override}
            </code>
          ) : (
            <span title={effective} className="truncate text-sm text-muted-foreground">
              {effective ? fallbackLabel(effective) : emptyLabel}
            </span>
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
        </div>
      )}
    </div>
  );
}
