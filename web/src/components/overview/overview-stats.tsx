import { useQuery } from '@tanstack/react-query';
import { Activity, Clock, Coins, MessagesSquare } from 'lucide-react';
import { StatCard } from '@/components/shared/stat-card';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { useSlackStatus } from '@/hooks/use-slack-status';
import { formatInterval, formatRelativeTime, formatTokens } from '@/lib/format';
import type { CronTask } from '@/types';

/** Four figures across the Overview, each linking to the page that manages it. */
export function OverviewStats() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <HeartbeatStat />
      <ChannelsStat />
      <ScheduledTasksStat />
      <UsageStat />
    </div>
  );
}

function HeartbeatStat() {
  const agent = useAgent();
  const { data: hbStatus } = useQuery({
    queryKey: ['heartbeat-status', agent.agentId],
    queryFn: () => runtimeApi.heartbeatStatus(),
    refetchInterval: 30_000,
  });

  return (
    <StatCard
      label="Heartbeat"
      icon={Activity}
      tone={hbStatus?.isActive ? 'success' : 'neutral'}
      to="/profile"
      isLoading={!hbStatus}
      value={hbStatus?.isActive ? 'Active' : 'Stopped'}
      detail={
        (hbStatus?.intervalMs ? `Every ${formatInterval(hbStatus.intervalMs)}` : '—') +
        (hbStatus?.lastRun ? ` · ${formatRelativeTime(hbStatus.lastRun)}` : '')
      }
    />
  );
}

function ChannelsStat() {
  const { workspace, isLoading, channelCount, hasDm } = useSlackStatus();
  return (
    <StatCard
      label="Channels"
      icon={MessagesSquare}
      tone={workspace ? 'primary' : 'neutral'}
      to="/channels"
      isLoading={isLoading}
      value={channelCount}
      detail={!workspace ? 'Slack not configured' : `${workspace.teamName}${hasDm ? ' · DM linked' : ''}`}
    />
  );
}

function ScheduledTasksStat() {
  const agent = useAgent();
  const { data: tasks, isLoading } = useQuery({
    queryKey: ['cron-tasks', agent.agentId],
    queryFn: () => runtimeApi.listCronTasks(),
  });

  const activeTasks = tasks?.filter((t) => t.isActive) ?? [];
  const nextRun = nextRunAt(activeTasks);
  const detail =
    !tasks || tasks.length === 0
      ? 'No tasks scheduled'
      : nextRun
        ? `Next run ${formatRelativeTime(nextRun)}`
        : `${activeTasks.length} active`;

  return (
    <StatCard
      label="Scheduled tasks"
      icon={Clock}
      tone={activeTasks.length > 0 ? 'warning' : 'neutral'}
      to="/cron"
      isLoading={isLoading}
      value={tasks?.length ?? 0}
      detail={detail}
    />
  );
}

function UsageStat() {
  const agent = useAgent();
  const { data: usage, isPending, isError } = useQuery({
    queryKey: ['llm-usage', agent.agentId, 24],
    queryFn: () => runtimeApi.llmUsage(24),
    refetchInterval: 30_000,
  });

  return (
    <StatCard
      label="Tokens today"
      icon={Coins}
      tone="teal"
      to="/activity"
      isLoading={isPending && !isError}
      value={usage ? formatTokens(usage.totalTokens) : '—'}
      detail={
        usage ? `${usage.calls} model call${usage.calls === 1 ? '' : 's'} in the last 24 hours` : 'Could not be read'
      }
    />
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
