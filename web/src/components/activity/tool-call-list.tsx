import { useEffect, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { Wrench, TriangleAlert } from 'lucide-react';
import ToolCallCard from '@/components/chat/tool-call-card';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { formatRelativeTime } from '@/lib/format';
import type { MessageTrigger } from '@/types';

const PAGE_SIZE = 30;

/** What started the turn a call belongs to. USER_INPUT needs no badge. */
const TRIGGER_LABELS: Partial<Record<MessageTrigger, string>> = {
  HEARTBEAT: 'Heartbeat',
  CRON_TASK: 'Scheduled',
  GOAL: 'Goal',
  WEBHOOK: 'Webhook',
};

/**
 * The agent's stored tool calls, newest turn first, loaded a page at a time as
 * the list is scrolled.
 *
 * Ordered by turn rather than by each call's own time, so two turns running at
 * once can interleave. See `services/tool-call-history.service.ts` for why.
 *
 * Stored is the limit of it: a heartbeat or scheduled run the DELIVER/SUPPRESS
 * gate suppressed publishes no message, so its calls were made but never
 * written down and cannot appear here.
 */
export function ToolCallList() {
  const agent = useAgent();
  const {
    data,
    isLoading,
    isError,
    isFetchingNextPage,
    isFetchNextPageError,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: ['tool-calls', agent.agentId],
    queryFn: ({ pageParam }) =>
      runtimeApi.listToolCalls({ limit: PAGE_SIZE, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const watcher = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = watcher.current;
    // Observe only while a page can be asked for and none is in flight or
    // failed. The effect re-runs as each fetch settles and re-observes, so a
    // short page keeps loading until the viewport is full.
    if (!node || !hasNextPage || isFetchingNextPage || isFetchNextPageError) return;

    // Measured against the viewport, clipped by the content pane that scrolls:
    // the watcher intersects once the pane is scrolled far enough to show it.
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void fetchNextPage();
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  const calls = data?.pages.flatMap((page) => page.items) ?? [];

  if (isLoading) {
    return (
      <Card>
        <CardContent className="space-y-2 py-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  // A read that failed is not an empty history, and saying "no tool calls yet"
  // would report one as the other.
  if (isError && calls.length === 0) {
    return (
      <Card>
        <EmptyState
          testId="activity-tool-calls-error"
          icon={TriangleAlert}
          title="The tool call history could not be read."
          className="py-10"
        />
      </Card>
    );
  }

  // Empty only once there is nothing left to ask for: a page can come back
  // with no calls and still carry a cursor.
  if (calls.length === 0 && !hasNextPage) {
    return (
      <Card>
        <EmptyState
          testId="activity-tool-calls-empty"
          icon={Wrench}
          title="No tool calls yet"
          description="They appear here as the agent uses its tools."
          className="py-10"
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="py-2">
        <div className="flex flex-col gap-0.5">
          {calls.map((call) => (
            <ToolCallCard
              key={call.id}
              testId="activity-tool-call"
              tc={call}
              meta={
                <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  {TRIGGER_LABELS[call.triggeredBy] && (
                    <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
                      {TRIGGER_LABELS[call.triggeredBy]}
                    </Badge>
                  )}
                  <span>{formatRelativeTime(call.timestamp)}</span>
                </span>
              }
            />
          ))}
        </div>

        {/* Scrolling this into view loads the next page. */}
        <div ref={watcher} className="h-8" />

        {isFetchingNextPage && (
          <p className="pb-2 text-center text-xs text-muted-foreground">Loading more…</p>
        )}
        {isFetchNextPageError && (
          <p className="pb-2 text-center text-xs text-muted-foreground">
            More could not be loaded.{' '}
            <button
              type="button"
              data-testid="activity-tool-calls-retry"
              onClick={() => void fetchNextPage()}
              className="text-primary hover:underline"
            >
              Try again
            </button>
          </p>
        )}
        {!hasNextPage && !isFetchNextPageError && (
          <p className="pb-2 text-center text-xs text-muted-foreground">
            {calls.length} tool call{calls.length === 1 ? '' : 's'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
