import { useInfiniteQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { Webhook, TriangleAlert } from 'lucide-react';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { WebhookRunRow } from './webhook-run-row';

const PAGE_SIZE = 10;

/** How often the list is read again while a run it shows has not finished. */
const PENDING_REFRESH_MS = 5_000;

/**
 * Every webhook event the runtime accepted, newest first, a page at a time
 * behind a button so the tool-call list below stays reachable.
 */
export function WebhookRunList() {
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
    queryKey: ['webhook-runs', agent.agentId],
    queryFn: ({ pageParam }) =>
      runtimeApi.listWebhookRuns({ limit: PAGE_SIZE, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some((run) => run.status === 'queued' || run.status === 'running'),
      )
        ? PENDING_REFRESH_MS
        : false,
  });

  const runs = data?.pages.flatMap((page) => page.items) ?? [];

  if (isLoading) {
    return (
      <Card>
        <CardContent className="space-y-2 py-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (isError && runs.length === 0) {
    return (
      <Card>
        <EmptyState
          testId="activity-webhook-runs-error"
          icon={TriangleAlert}
          title="The webhook runs could not be read."
          className="py-10"
        />
      </Card>
    );
  }

  if (runs.length === 0) {
    return (
      <Card>
        <EmptyState
          testId="activity-webhook-runs-empty"
          icon={Webhook}
          title="No webhook runs yet"
          description="Each event a webhook accepts appears here with its result."
          className="py-10"
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="py-2">
        <div className="flex flex-col gap-0.5">
          {runs.map((run) => (
            <WebhookRunRow key={run.id} run={run} />
          ))}
        </div>

        {hasNextPage && (
          <p className="pt-2 pb-1 text-center text-xs text-muted-foreground">
            {isFetchNextPageError && 'More could not be loaded. '}
            <button
              type="button"
              data-testid="activity-webhook-runs-more"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
              className="text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
            >
              {isFetchingNextPage ? 'Loading…' : isFetchNextPageError ? 'Try again' : 'Show more'}
            </button>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
