import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { formatInterval, formatRelativeTime } from '@/lib/format';

export function HeartbeatCard() {
  const agent = useAgent();
  const { data: hbStatus, isLoading } = useQuery({
    queryKey: ['heartbeat-status', agent.agentId],
    queryFn: () => runtimeApi.heartbeatStatus(),
    refetchInterval: 30_000,
  });

  return (
    <Link to="/profile" className="stat-link" aria-label="Heartbeat">
      <Card className="stat-card h-full">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardDescription>Heartbeat</CardDescription>
          <Activity className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {isLoading || !hbStatus ? (
            <Skeleton className="h-7 w-20" />
          ) : (
            <>
              <div className="text-3xl font-semibold tracking-tight tabular-nums">
                {hbStatus.isActive ? 'Active' : 'Stopped'}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {hbStatus.intervalMs ? `Every ${formatInterval(hbStatus.intervalMs)}` : '—'}
                {hbStatus.lastRun ? ` · ${formatRelativeTime(hbStatus.lastRun)}` : ''}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
