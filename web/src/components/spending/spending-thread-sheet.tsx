import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { formatUsd, withMentionNames } from '@/lib/spending';
import { SpendingRequestRow } from './spending-request-row';

/** One conversation's spend, one row per request, newest first. */
export function SpendingThreadSheet({ threadId, onClose }: { threadId: string | null; onClose: () => void }) {
  const agent = useAgent();
  const { data, isPending, isError } = useQuery({
    queryKey: ['spending-thread', agent.agentId, threadId],
    queryFn: () => runtimeApi.spendingThread(threadId!),
    enabled: threadId !== null,
  });

  return (
    <Sheet open={threadId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg" data-testid="spending-thread-sheet">
        <SheetHeader className="border-b border-foreground/8 pr-12">
          <SheetTitle className="truncate">{data?.title ? withMentionNames(data.title) : isPending ? 'Conversation' : 'Untitled conversation'}</SheetTitle>
          <SheetDescription>
            {data ? `${formatUsd(data.costUsd)} across ${data.requests.length} request${data.requests.length === 1 ? '' : 's'}` : ' '}
          </SheetDescription>
          {data?.opensInChat && (
            <Link to="/chat/$threadId" params={{ threadId: data.threadId }} className="mt-1 inline-flex w-fit items-center gap-1 text-xs text-primary-soft hover:underline">
              Open conversation <ArrowUpRight aria-hidden="true" className="size-3" />
            </Link>
          )}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {isPending && threadId !== null && <Skeleton className="m-2 h-24" />}
          {isError && <p className="p-2 text-sm text-muted-foreground">This conversation's spending could not be read.</p>}
          {data && (
            <ul className="divide-y divide-foreground/8" data-testid="spending-requests">
              {data.requests.map((request) => (
                <SpendingRequestRow key={request.requestId} request={request} />
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
