import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { runtimeApi, type SpendRange } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { formatRelativeTime } from '@/lib/format';
import { formatUsd, withMentionNames } from '@/lib/spending';

const PAGE_SIZE = 20;

/** The range's conversations by spend, a page at a time. A row opens the conversation's detail. */
export function SpendingThreadsTable({
  range,
  total,
  onOpen,
}: {
  range: SpendRange;
  /** The range's whole spend, which each row's share is of. */
  total: number;
  onOpen: (threadId: string) => void;
}) {
  const agent = useAgent();
  // One page per Show more, read from the offset the last page returned, so a page
  // never asks for more than the route's page-size limit.
  const { data, isPending, isError, isFetchingNextPage, hasNextPage, fetchNextPage } = useInfiniteQuery({
    queryKey: ['spending-threads', agent.agentId, range.from, range.to],
    queryFn: ({ pageParam }) => runtimeApi.spendingThreads(range, { limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
  });
  // A conversation whose spend moved between two page reads can be on both; list it once.
  const threads = useMemo(() => {
    const seen = new Set<string>();
    return (data?.pages ?? []).flatMap((page) => page.threads).filter((t) => {
      if (seen.has(t.threadId)) return false;
      seen.add(t.threadId);
      return true;
    });
  }, [data]);

  if (isPending) return <div className="h-32 rounded-xl bg-card ring-1 ring-foreground/10" />;
  if (isError) return <p className="text-sm text-muted-foreground">The conversations could not be read.</p>;
  if (threads.length === 0) {
    return <p className="rounded-xl bg-card p-6 text-center text-sm text-muted-foreground ring-1 ring-foreground/10">No conversation spent anything in this range.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <Table data-testid="spending-threads">
          <TableHeader>
            <TableRow>
              <TableHead>Conversation</TableHead>
              <TableHead className="hidden sm:table-cell">Last active</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Requests</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="hidden w-32 md:table-cell"><span className="sr-only">Share</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {threads.map((thread) => (
              <TableRow key={thread.threadId} data-testid="spending-thread-row" className="cursor-pointer" onClick={() => onOpen(thread.threadId)}>
                <TableCell className="max-w-0 w-full">
                  <button type="button" className="block w-full truncate text-left text-sm text-foreground outline-none hover:underline focus-visible:underline" onClick={(e) => { e.stopPropagation(); onOpen(thread.threadId); }}>
                    {thread.title ? withMentionNames(thread.title) : 'Untitled conversation'}
                  </button>
                </TableCell>
                <TableCell className="hidden text-xs whitespace-nowrap text-muted-foreground sm:table-cell">{formatRelativeTime(thread.lastCallAt)}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{thread.requests}</TableCell>
                <TableCell className="text-right font-medium whitespace-nowrap text-strong tabular-nums">{formatUsd(thread.costUsd)}</TableCell>
                <TableCell className="hidden md:table-cell">
                  <div className="h-1.5 overflow-hidden rounded-full bg-foreground/8" aria-hidden="true">
                    <div className="h-full rounded-full bg-primary/70" style={{ width: `${total > 0 ? Math.min(100, (thread.costUsd / total) * 100) : 0}%` }} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {hasNextPage && (
        <Button variant="outline" size="sm" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
          Show more
        </Button>
      )}
    </div>
  );
}
