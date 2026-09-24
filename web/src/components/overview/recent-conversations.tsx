import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, MessageSquare, MessagesSquare } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { IconTile } from '@/components/shared/icon-tile';
import { SectionHeader } from '@/components/layout/section-header';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { formatRelativeTime } from '@/lib/format';
import { threadDisplayName } from '@/lib/thread-name';

const SHOWN = 5;

/** The newest conversations, one click from the Overview. */
export function RecentConversations() {
  const agent = useAgent();
  const { data: threads, isLoading } = useQuery({
    queryKey: ['threads', agent.agentId, 'recents'],
    queryFn: () =>
      runtimeApi.listThreads(agent.agentId, agent.userId, {
        threadSource: 'DATABASE',
        limit: 100,
      }),
  });

  return (
    <section className="space-y-3">
      <SectionHeader
        title="Recent conversations"
        actions={
          <Link to="/chat" className="text-xs font-medium text-primary hover:underline">
            Open chat
          </Link>
        }
      />
      <Card className="gap-0 py-1.5">
        {isLoading ? (
          <div className="space-y-2 p-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : threads && threads.length > 0 ? (
          <ul data-testid="overview-recent-conversations">
            {threads.slice(0, SHOWN).map((thread) => (
              <li key={thread.id}>
                <Link
                  to="/chat/$threadId"
                  params={{ threadId: thread.id }}
                  className="group/row mx-1.5 flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-accent"
                >
                  <IconTile icon={MessageSquare} />
                  <span className="min-w-0 flex-1 truncate text-sm text-strong">{threadDisplayName(thread)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(thread.updatedAt)}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={MessagesSquare}
            title="No conversations yet"
            description="Say hello to your agent. Your conversations show up here."
            className="py-10"
          />
        )}
      </Card>
    </section>
  );
}
