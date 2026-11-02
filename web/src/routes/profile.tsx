import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
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
import { ModelSettingsCard } from '@/components/profile/model-settings-card';
import { VerbosityField } from '@/components/profile/verbosity-field';
import { LockedInField } from '@/components/profile/locked-in-field';
import { DocumentWorkspace } from '@/components/profile/document-workspace';
import { HeartbeatDeliveryField } from '@/components/profile/heartbeat-delivery-field';
import { CodingAgentsCard } from '@/components/coding-agents/coding-agents-card';
import { codingAgentSignInSearch } from '@/lib/coding-agents';
import { Page } from '@/components/layout/page';
import { PageHeader } from '@/components/layout/page-header';
import { StatusPill } from '@/components/shared/status-pill';
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

export const Route = createFileRoute('/profile')({
  validateSearch: codingAgentSignInSearch,
  component: ProfilePage,
});

function ProfilePage() {
  const agent = useAgent();
  const [restoreOpen, setRestoreOpen] = useState(false);
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const { data: details, isLoading } = useQuery({
    queryKey: ['agent-details', agent.agentId],
    queryFn: () => runtimeApi.details(),
  });

  if (isLoading) {
    return (
      <Page>
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </Page>
    );
  }

  return (
    <Page className="space-y-6">
      <PageHeader
        title="Profile"
        description="Shape how your agent thinks, works, and remembers."
        actions={
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
        }
      />

      <RestoreBackupDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
      />

      <Card>
        <CardHeader><CardTitle>Agent settings</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0 [&>*]:rounded-xl [&>*]:bg-muted/15 [&>*]:p-3.5 [&>*]:ring-1 [&>*]:ring-border [&>*]:ring-inset [&>*]:break-words">
          <AgentNameField />
          {details && <VerbosityField details={details} />}
          {details && <LockedInField details={details} />}
        </CardContent>
      </Card>

      <ModelSettingsCard />

      <StatusPanel details={details} isLoading={isLoading} />

      <CodingAgentsCard
        key={`${search.agent}:${search['sign-in']}`}
        signIn={search.agent && { agent: search.agent }}
        onSignInClosed={
          search.agent ? () => void navigate({ search: {}, replace: true, resetScroll: false }) : undefined
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Identity documents</CardTitle>
          <p className="text-sm text-foreground/70">Manage your agent’s instructions and saved versions.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {details ? (
            <Tabs defaultValue="agentMd">
              <TabsList variant="line" className="min-h-10 max-w-full justify-start overflow-x-auto overflow-y-hidden pb-2">
                {SECTIONS.map((s) => (
                  <TabsTrigger key={s.key} value={s.key}>
                    <s.icon className="size-4" />
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {SECTIONS.map((s) => (
                <TabsContent key={s.key} value={s.key}>
                  <DocumentWorkspace field={s.key} label={s.label} details={details} />
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            <div className="text-sm text-muted-foreground">Agent details unavailable</div>
          )}
        </CardContent>
      </Card>

    </Page>
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


  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4 text-muted-foreground" />
          Heartbeat Status
        </CardTitle>
        {!isLoading && details && <StatusPill status={details.status} />}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 [&>*]:rounded-xl [&>*]:bg-muted/15 [&>*]:p-3.5 [&>*]:ring-1 [&>*]:ring-border [&>*]:ring-inset">
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
        <HeartbeatDeliveryField agentId={agent.agentId} />
        <div className="flex flex-wrap gap-2">
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
