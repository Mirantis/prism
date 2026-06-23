import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Activity,
  Power,
  Play,
  AlertCircle,
  Bot,
  Heart,
  User as UserIcon,
  Brain,
  Eye,
  Wrench,
  Pencil,
  Archive,
  ChevronDown,
  Download,
  Upload,
} from 'lucide-react';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { formatInterval } from '@/lib/format';
import { RestoreBackupDialog } from '@/components/profile/restore-backup-dialog';
import type { AgentDetails } from '@/types';

const SECTIONS = [
  { key: 'agentMd', label: 'Agent', icon: Bot },
  { key: 'soulMd', label: 'Soul', icon: Heart },
  { key: 'userMd', label: 'User', icon: UserIcon },
  { key: 'heartbeatMd', label: 'Heartbeat', icon: Activity },
  { key: 'memoryMd', label: 'Memory', icon: Brain },
  { key: 'visionMd', label: 'Vision', icon: Eye },
  { key: 'bootstrapMd', label: 'Bootstrap', icon: Wrench },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

export const Route = createFileRoute('/profile')({
  component: ProfilePage,
});

function ProfilePage() {
  const agent = useAgent();
  const [restoreOpen, setRestoreOpen] = useState(false);

  const { data: details, isLoading } = useQuery({
    queryKey: ['agent-details', agent.agentId],
    queryFn: () => runtimeApi.details(),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-32 mt-6" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Profile</h2>
          <p className="text-sm text-muted-foreground">
            Agent identity, heartbeat status, and workspace markdown files.
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm">
                <Archive className="size-4" />
                Backup
                <ChevronDown className="size-4 opacity-60" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              render={
                <a href="/agents/export" download>
                  <Download className="size-4" />
                  Export
                </a>
              }
            />
            <DropdownMenuItem onClick={() => setRestoreOpen(true)}>
              <Upload className="size-4" />
              Restore
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <RestoreBackupDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
      />

      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <AgentNameField />
          <ModelField
            label="Model"
            queryKey="agent-model"
            load={() => runtimeApi.getModel()}
            save={(m) => runtimeApi.updateModel(m)}
            affects={['agent-heartbeat-model', 'agent-cron-model']}
          />
          <ModelField
            label="Heartbeat model"
            queryKey="agent-heartbeat-model"
            load={() => runtimeApi.getHeartbeatModel()}
            save={(m) => runtimeApi.updateHeartbeatModel(m)}
            allowEmpty
          />
          <ModelField
            label="Scheduled-task model"
            queryKey="agent-cron-model"
            load={() => runtimeApi.getCronModel()}
            save={(m) => runtimeApi.updateCronModel(m)}
            allowEmpty
          />
          {details ? (
            <Tabs defaultValue="agentMd">
              <TabsList variant="line">
                {SECTIONS.map((s) => (
                  <TabsTrigger key={s.key} value={s.key}>
                    <s.icon className="size-4" />
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {SECTIONS.map((s) => (
                <TabsContent key={s.key} value={s.key}>
                  <Textarea
                    value={details[s.key as SectionKey] ?? ''}
                    readOnly
                    className="mt-3 h-64 resize-none font-mono text-xs"
                  />
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            <div className="text-sm text-muted-foreground">Agent details unavailable</div>
          )}
        </CardContent>
      </Card>

      <StatusPanel details={details} isLoading={isLoading} />
    </div>
  );
}

function AgentNameField() {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name);
  const [error, setError] = useState<string | null>(null);

  const renameMut = useMutation({
    mutationFn: (n: string) => runtimeApi.updateAgentName(n),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent', 'me'] });
      setEditing(false);
      setError(null);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Rename failed'),
  });

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 64;

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">Name</span>
      {editing ? (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && valid && !renameMut.isPending) {
                renameMut.mutate(trimmed);
              } else if (e.key === 'Escape') {
                setName(agent.name);
                setEditing(false);
                setError(null);
              }
            }}
            maxLength={64}
            className="h-7 w-[240px] px-2 py-1 text-sm"
            aria-label="Agent name"
            autoFocus
          />
          <Button
            size="sm"
            onClick={() => renameMut.mutate(trimmed)}
            disabled={!valid || renameMut.isPending || trimmed === agent.name}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setName(agent.name);
              setEditing(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
          {error && <span className="basis-full text-xs text-destructive">{error}</span>}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-sm">
          {agent.name}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              setName(agent.name);
              setError(null);
              setEditing(true);
            }}
            aria-label="Edit agent name"
          >
            <Pencil className="size-3" />
          </Button>
        </span>
      )}
    </div>
  );
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9._:\-/]+$/;
const MODEL_ID_MAX_LEN = 200;

/**
 * Editable model-ID field. Used for the main agent model and for the
 * heartbeat/cron overrides. When `allowEmpty` is set the field may be cleared
 * to fall back to the main model; the resolved fallback is shown as a hint via
 * the `effective` value returned by the loader.
 */
function ModelField({
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

function StatusPanel({ details, isLoading }: { details: AgentDetails | undefined; isLoading: boolean }) {
  const agent = useAgent();
  const queryClient = useQueryClient();

  const { data: hbStatus } = useQuery({
    queryKey: ['heartbeat-status', agent.agentId],
    queryFn: () => runtimeApi.heartbeatStatus(),
    refetchInterval: 5000,
  });

  const startMut = useMutation({
    mutationFn: () => runtimeApi.heartbeatStart(details!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['heartbeat-status', agent.agentId] }),
  });
  const stopMut = useMutation({
    mutationFn: () => runtimeApi.heartbeatStop(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['heartbeat-status', agent.agentId] }),
  });
  const triggerMut = useMutation({
    mutationFn: () => runtimeApi.heartbeatTrigger(),
  });

  const statusLabel = details?.status ?? 'unknown';
  const statusVariant: 'default' | 'secondary' | 'destructive' =
    statusLabel === 'RUNNING' ? 'default' : statusLabel === 'ERROR' ? 'destructive' : 'secondary';

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4 text-muted-foreground" />
          Heartbeat Status
        </CardTitle>
        {!isLoading && (
          <Badge variant={statusVariant} className="uppercase">
            {statusLabel}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          <Field label="Heartbeat">
            {hbStatus ? (
              <span className={hbStatus.isActive ? 'text-foreground' : 'text-muted-foreground'}>
                {hbStatus.isActive ? 'Active' : 'Stopped'}
              </span>
            ) : (
              <Skeleton className="h-4 w-16" />
            )}
          </Field>
          <Field label="Interval">
            <IntervalEditor
              intervalMs={hbStatus?.intervalMs ?? null}
              agentId={agent.agentId}
              disabled={!hbStatus?.isActive}
            />
          </Field>
          <Field label="Last heartbeat">
            {hbStatus?.lastRun ? new Date(hbStatus.lastRun).toLocaleString() : <span className="text-muted-foreground">—</span>}
          </Field>
          <Field label="Consecutive errors">
            {hbStatus ? (
              <span className={hbStatus.consecutiveErrors > 0 ? 'text-destructive' : ''}>
                {hbStatus.consecutiveErrors > 0 && <AlertCircle className="mr-1 inline size-3" />}
                {hbStatus.consecutiveErrors}
              </span>
            ) : (
              '—'
            )}
          </Field>
        </div>
        <div className="flex gap-2 border-t border-border pt-4">
          {hbStatus?.isActive ? (
            <Button size="sm" variant="outline" onClick={() => stopMut.mutate()} disabled={stopMut.isPending}>
              <Power className="size-3.5" /> Stop heartbeat
            </Button>
          ) : (
            <Button size="sm" onClick={() => startMut.mutate()} disabled={startMut.isPending || !details}>
              <Play className="size-3.5" /> Start heartbeat
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => triggerMut.mutate()} disabled={triggerMut.isPending}>
            Trigger now
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function IntervalEditor({
  intervalMs,
  agentId,
  disabled,
}: {
  intervalMs: number | null;
  agentId: string;
  disabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [minutes, setMinutes] = useState<number>(intervalMs ? Math.round(intervalMs / 60000) : 480);
  const [error, setError] = useState<string | null>(null);

  const updateMut = useMutation({
    mutationFn: (mins: number) =>
      runtimeApi.updateHeartbeatInterval(mins * 60000),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['heartbeat-status', agentId] });
      setEditing(false);
      setError(null);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Update failed'),
  });

  if (intervalMs == null && !editing) {
    return <span className="text-muted-foreground">—</span>;
  }

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1">
        Every {formatInterval(intervalMs)}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            setMinutes(intervalMs ? Math.round(intervalMs / 60000) : 480);
            setError(null);
            setEditing(true);
          }}
          disabled={disabled}
          aria-label="Edit interval"
        >
          <Pencil className="size-3" />
        </Button>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Input
        type="number"
        min={1}
        max={10080}
        value={minutes}
        onChange={(e) => setMinutes(Number(e.target.value))}
        className="h-7 w-[80px] px-2 py-1 text-sm"
        aria-label="Interval minutes"
      />
      <span className="text-xs text-muted-foreground">min</span>
      <Button
        size="sm"
        onClick={() => updateMut.mutate(minutes)}
        disabled={updateMut.isPending || !Number.isFinite(minutes) || minutes < 1 || minutes > 10080}
      >
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
      {error && <span className="basis-full text-xs text-destructive">{error}</span>}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}
