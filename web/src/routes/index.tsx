import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, MessageSquare } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { HeartbeatCard } from '@/components/overview/heartbeat-card';
import { ChannelsCard } from '@/components/overview/channels-card';
import { ScheduledTasksCard } from '@/components/overview/scheduled-tasks-card';
import { RecentConversations } from '@/components/overview/recent-conversations';
import { WorkspaceShortcuts } from '@/components/overview/workspace-shortcuts';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';

export const Route = createFileRoute('/')({ component: OverviewPage });

function OverviewPage() {
  const agent = useAgent();
  const { data: details, isLoading } = useQuery({
    queryKey: ['agent-details', agent.agentId],
    queryFn: () => runtimeApi.details(),
  });

  return (
    <div className="page-content space-y-6 lg:space-y-7">
      <section className="overview-hero relative overflow-hidden rounded-2xl border border-border p-6 sm:p-7 lg:p-8">
        <div className="relative z-10 max-w-2xl">
          <p className="eyebrow mb-3">Your workspace</p>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <h1 className="break-words text-3xl font-semibold tracking-tight sm:text-4xl">
              {agent.name}
            </h1>
            {details && (
              <Badge
                variant={details.status === 'ERROR' ? 'destructive' : 'secondary'}
                className="gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
              >
                <span
                  className={`size-1.5 rounded-full ${details.status === 'RUNNING' ? 'bg-primary' : 'bg-current'}`}
                />
                {details.status}
              </Badge>
            )}
          </div>
          <p className="max-w-md text-base leading-relaxed text-muted-foreground">
            Your conversations, routines, and agent. All in one place.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button
              nativeButton={false}
              size="lg"
              className="h-11 px-4"
              render={<Link to="/chat" />}
            >
              <MessageSquare className="size-4" />
              Open chat
              <ArrowRight className="ml-2 size-4" />
            </Button>
            <Button
              nativeButton={false}
              variant="ghost"
              size="lg"
              className="h-11 px-4"
              render={<Link to="/profile" />}
            >
              Customize agent
            </Button>
          </div>
        </div>
        <img
          src="/prism-logo.svg"
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute -right-10 top-1/2 hidden size-72 -translate-y-1/2 opacity-[0.07] lg:block"
        />
      </section>

      <section aria-label="Agent summary">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight">At a glance</h2>
          <Link
            to="/activity"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            View activity <ArrowRight className="size-3.5" />
          </Link>
        </div>
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-36 rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <HeartbeatCard />
            <ChannelsCard />
            <ScheduledTasksCard />
          </div>
        )}
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <RecentConversations />
        <WorkspaceShortcuts />
      </div>
    </div>
  );
}
