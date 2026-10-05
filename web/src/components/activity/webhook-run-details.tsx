import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Skeleton } from '@/components/ui/skeleton';
import ChatMarkdown from '@/components/chat/ChatMarkdown';
import ToolCallCard from '@/components/chat/tool-call-card';
import { runtimeApi } from '@/api/runtime-client';
import type { WebhookRunSummary } from '@/types';

function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function Label({ children }: { children: string }) {
  return (
    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * What a finished run delivered: the message, a link to its conversation when
 * that is a web chat, and the tool calls the message stored.
 */
export function WebhookRunDetails({ run }: { run: WebhookRunSummary }) {
  const pending = run.status === 'queued' || run.status === 'running';
  // Keyed on the status, so a run that finishes while open is read again.
  const { data, isLoading, isError } = useQuery({
    queryKey: ['webhook-run', run.id, run.status],
    queryFn: () => runtimeApi.getWebhookRun(run.id),
    enabled: !pending,
  });

  const frame = 'ml-[18px] space-y-3 border-l border-border py-2 pl-4 text-xs';

  if (pending) {
    return <div className={`${frame} text-muted-foreground`}>The run has not finished.</div>;
  }

  if (isLoading) {
    return (
      <div className={frame}>
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return <div className={`${frame} text-muted-foreground`}>This run could not be read.</div>;
  }

  return (
    <div className={frame} data-testid="activity-webhook-run-details">
      {data.finishedAt && (
        <p className="text-muted-foreground">
          Took {formatDuration(new Date(data.finishedAt).getTime() - new Date(data.createdAt).getTime())}
        </p>
      )}

      {!data.delivered && (
        <p className={data.error ? 'text-destructive' : 'text-muted-foreground'}>
          {data.error ?? 'No delivered message is stored for this run.'}
        </p>
      )}

      {data.delivered && (
        <div>
          <Label>Delivered message</Label>
          <div
            data-testid="activity-webhook-run-message"
            className="rounded-md bg-muted/50 p-3 text-sm text-foreground"
          >
            <ChatMarkdown content={data.delivered.content} />
          </div>
          {data.message?.inWebChat && (
            <Link
              to="/chat/$threadId"
              params={{ threadId: data.message.threadId }}
              className="mt-1 inline-block text-primary hover:underline"
            >
              Open conversation
            </Link>
          )}
        </div>
      )}

      {data.delivered && data.delivered.toolCalls.length > 0 && (
        <div>
          <Label>Tool calls</Label>
          <div className="flex flex-col gap-0.5">
            {data.delivered.toolCalls.map((tc, i) => (
              <ToolCallCard key={i} tc={tc} testId="activity-webhook-run-tool-call" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
