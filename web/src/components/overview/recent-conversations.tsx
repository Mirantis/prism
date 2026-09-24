import { Link } from '@tanstack/react-router';
import { ArrowRight, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useRecentThreads } from '@/hooks/use-recent-threads';
import { threadDisplayName } from '@/lib/thread-name';
import { formatRelativeTime } from '@/lib/format';

export function RecentConversations() {
  const { data: threads, isLoading, isError, refetch } = useRecentThreads();
  return (
    <section
      className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card"
      aria-labelledby="recent-conversations-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-5 sm:px-6">
        <div>
          <h2 id="recent-conversations-title" className="text-base font-semibold">
            Recent conversations
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Pick up where you left off.</p>
        </div>
        <Link
          to="/chat"
          className="inline-flex items-center gap-2 text-xs text-primary hover:underline"
        >
          View all <ArrowRight className="size-3.5" />
        </Link>
      </div>
      {isLoading ? (
        <div className="space-y-4 p-6">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : isError ? (
        <div className="space-y-3 p-6 text-sm">
          <p>Conversations could not be loaded.</p>
          <Button variant="outline" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      ) : threads?.length ? (
        <ul className="divide-y divide-border">
          {threads.slice(0, 4).map((thread) => (
            <li key={thread.id}>
              <Link
                to="/chat/$threadId"
                params={{ threadId: thread.id }}
                className="group flex items-center gap-3 px-5 py-5 transition-colors hover:bg-accent sm:px-6"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
                  <MessageSquare className="size-4 text-muted-foreground" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {threadDisplayName(thread)}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Created {formatRelativeTime(thread.createdAt)}
                  </span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <MessageSquare className="mb-3 size-6 text-muted-foreground" />
          <p className="text-sm font-medium">Your next idea starts here</p>
          <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">
            Open chat to start a conversation. You can return to it here.
          </p>
        </div>
      )}
    </section>
  );
}
