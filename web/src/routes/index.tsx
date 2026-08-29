import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  Clock,
  MessageSquare,
  MessagesSquare,
} from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { formatInterval, formatRelativeTime } from '@/lib/format';
import type { AgentDetails, CronTask } from '@/types';

export const Route = createFileRoute('/')({
  component: OverviewPage,
});

function OverviewPage() {
  const agent = useAgent();
  const navigate = useNavigate();

  const { data: details, isLoading } = useQuery({
    queryKey: ['agent-details', agent.agentId],
    queryFn: () => runtimeApi.details(),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <div className="mt-6 grid gap-4 md:grid-cols-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{agent.name}</h2>
          <div className="mt-1 flex items-center gap-2">
            {details && (
              <Badge variant="secondary" className="font-mono text-xs">
                {details.agentType}
              </Badge>
            )}
            {details && <StatusBadge status={details.status} />}
          </div>
        </div>
        <Button onClick={() => navigate({ to: '/chat' })}>
          <MessageSquare />
          Chat
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <HeartbeatCard onClick={() => navigate({ to: '/profile' })} />
        <ChannelsCard onClick={() => navigate({ to: '/channels' })} />
        <ScheduledTasksCard onClick={() => navigate({ to: '/cron' })} />
        <CreatedCard details={details} />
      </div>

      <WelcomeCard />
    </div>
  );
}

function WelcomeCard() {
  const navigate = useNavigate();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome to Prism Agent</CardTitle>
        <CardDescription>
          Your autonomous agent — it learns, remembers, and operates on its own. Defined by you, not by us.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          <ActionTile
            icon={MessageSquare}
            title="Start a conversation"
            description="Train your agent through chat — tell it what to monitor and how to act."
            onClick={() => navigate({ to: '/chat' })}
          />
          <ActionTile
            icon={MessagesSquare}
            title="Link it to Slack"
            description="DM your agent or wire it up to watch a channel."
            onClick={() => navigate({ to: '/channels' })}
          />
          <ActionTile
            icon={Clock}
            title="Schedule recurring tasks"
            description="Run cron-driven checks and reports on your schedule."
            onClick={() => navigate({ to: '/cron' })}
          />
          <ActionTile
            icon={Bot}
            title="Customize its personality"
            description="Edit identity, heartbeat, memory and vision in plain markdown."
            onClick={() => navigate({ to: '/profile' })}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ActionTile({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent/50"
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <div className="space-y-0.5">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant: 'default' | 'secondary' | 'destructive' =
    status === 'RUNNING' ? 'default' : status === 'ERROR' ? 'destructive' : 'secondary';
  return (
    <Badge variant={variant} className="uppercase">
      {status}
    </Badge>
  );
}

function HeartbeatCard({ onClick }: { onClick: () => void }) {
  const agent = useAgent();
  const { data: hbStatus, isLoading } = useQuery({
    queryKey: ['heartbeat-status', agent.agentId],
    queryFn: () => runtimeApi.heartbeatStatus(),
    refetchInterval: 30_000,
  });

  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-accent/50"
      onClick={onClick}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardDescription>Heartbeat</CardDescription>
        <Activity className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading || !hbStatus ? (
          <Skeleton className="h-7 w-20" />
        ) : (
          <>
            <div className="text-2xl font-bold">{hbStatus.isActive ? 'Active' : 'Stopped'}</div>
            <p className="text-xs text-muted-foreground">
              {hbStatus.intervalMs ? `Every ${formatInterval(hbStatus.intervalMs)}` : '—'}
              {hbStatus.lastRun ? ` · ${formatRelativeTime(hbStatus.lastRun)}` : ''}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ChannelsCard({ onClick }: { onClick: () => void }) {
  const agent = useAgent();
  const { data: workspacesResp, isLoading: workspacesLoading } = useQuery({
    queryKey: ['slack-workspaces'],
    queryFn: () => runtimeApi.slackWorkspaces(),
  });
  const workspace = workspacesResp?.workspaces[0];

  const { data: linkStatus } = useQuery({
    queryKey: ['slack-link-status', agent.agentId],
    queryFn: () => runtimeApi.slackLinkStatus(),
    enabled: Boolean(workspace),
  });
  const { data: channelsResp } = useQuery({
    queryKey: ['slack-channel-mappings', agent.agentId],
    queryFn: () => runtimeApi.slackChannelMappings(),
    enabled: Boolean(workspace),
  });

  const count = channelsResp?.channels.length ?? 0;
  const subtitle = !workspace
    ? 'Not configured'
    : `${workspace.teamName}${linkStatus?.hasDmMapping ? ' · DM linked' : ''}`;

  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-accent/50"
      onClick={onClick}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardDescription>Channels</CardDescription>
        <MessagesSquare className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {workspacesLoading ? (
          <Skeleton className="h-7 w-12" />
        ) : (
          <>
            <div className="text-2xl font-bold">{count}</div>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ScheduledTasksCard({ onClick }: { onClick: () => void }) {
  const agent = useAgent();
  const { data: tasks, isLoading } = useQuery({
    queryKey: ['cron-tasks', agent.agentId],
    queryFn: () => runtimeApi.listCronTasks(),
  });

  const activeTasks = tasks?.filter((t) => t.isActive) ?? [];
  const nextRun = nextRunAt(activeTasks);
  const subtitle = !tasks || tasks.length === 0
    ? 'No tasks scheduled'
    : nextRun
      ? `Next run ${formatRelativeTime(nextRun)}`
      : `${activeTasks.length} active`;

  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-accent/50"
      onClick={onClick}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardDescription>Scheduled Tasks</CardDescription>
        <Clock className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-7 w-12" />
        ) : (
          <>
            <div className="text-2xl font-bold">{tasks?.length ?? 0}</div>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CreatedCard({ details }: { details: AgentDetails | undefined }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardDescription>Created</CardDescription>
        <Clock className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {!details ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <>
            <div className="text-2xl font-bold">
              {new Date(details.createdAt).toLocaleDateString()}
            </div>
            <p className="text-xs text-muted-foreground">
              Updated {formatRelativeTime(details.updatedAt)}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function nextRunAt(tasks: CronTask[]): string | null {
  const times = tasks
    .map((t) => t.nextRunAt)
    .filter((v): v is string => Boolean(v))
    .map((v) => ({ raw: v, ts: new Date(v).getTime() }))
    .filter((v) => Number.isFinite(v.ts) && v.ts >= Date.now());
  if (times.length === 0) return null;
  times.sort((a, b) => a.ts - b.ts);
  return times[0].raw;
}
