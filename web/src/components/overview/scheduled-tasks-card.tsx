import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { formatRelativeTime } from '@/lib/format';
import type { CronTask } from '@/types';

export function ScheduledTasksCard() {
  const agent = useAgent();
  const { data: tasks, isLoading } = useQuery({
    queryKey: ['cron-tasks', agent.agentId],
    queryFn: () => runtimeApi.listCronTasks(),
  });

  const activeTasks = tasks?.filter((t) => t.isActive) ?? [];
  const nextRun = nextRunAt(activeTasks);
  const subtitle =
    !tasks || tasks.length === 0
      ? 'No tasks scheduled'
      : nextRun
        ? `Next run ${formatRelativeTime(nextRun)}`
        : `${activeTasks.length} active`;

  return (
    <Link to="/cron" className="stat-link" aria-label="Scheduled Tasks">
      <Card className="stat-card h-full">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardDescription>Scheduled Tasks</CardDescription>
          <Clock className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-7 w-12" />
          ) : (
            <>
              <div className="text-3xl font-semibold tracking-tight tabular-nums">
                {tasks?.length ?? 0}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{subtitle}</p>
            </>
          )}
        </CardContent>
      </Card>
    </Link>
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
