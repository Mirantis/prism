import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { formatTokens } from '@/lib/format';
import { formatUsd, purposeLabel, shortModel } from '@/lib/spending';

/** The share of a prompt read from cache, or a dash where nothing was sent. */
function cacheShare(cacheRead: number, input: number): string {
  return input > 0 ? `${Math.round((cacheRead / input) * 100)}%` : '—';
}

/** What one request spent, per purpose and model, with tokens and the share read from cache. */
export function SpendingRequestDetails({ requestId }: { requestId: string }) {
  const agent = useAgent();
  const { data, isPending, isError } = useQuery({
    queryKey: ['spending-request', agent.agentId, requestId],
    queryFn: () => runtimeApi.spendingRequest(requestId),
  });

  if (isPending) return <Skeleton className="h-12 w-full" />;
  if (isError) return <p className="text-xs text-muted-foreground">Could not be read.</p>;

  return (
    <div className="space-y-2 text-xs" data-testid="spending-request-details">
      <table className="w-full">
        <thead className="text-muted-foreground">
          <tr>
            <th className="pb-1 text-left font-normal">For</th>
            <th className="pb-1 text-right font-normal">In</th>
            <th className="pb-1 text-right font-normal">Out</th>
            <th className="pb-1 text-right font-normal">Cached</th>
            <th className="pb-1 text-right font-normal">Cost</th>
          </tr>
        </thead>
        <tbody>
          {data.byPurpose.map((row) => (
            <tr key={row.purpose}>
              <td className="py-0.5 text-foreground">
                {purposeLabel(row.purpose)}
                <span className="text-muted-foreground"> · {row.calls} call{row.calls === 1 ? '' : 's'}</span>
              </td>
              <td className="py-0.5 text-right tabular-nums">{formatTokens(row.inputTokens)}</td>
              <td className="py-0.5 text-right tabular-nums">{formatTokens(row.outputTokens)}</td>
              <td className="py-0.5 text-right tabular-nums">{cacheShare(row.cacheReadTokens, row.inputTokens)}</td>
              <td className="py-0.5 text-right text-foreground tabular-nums">{formatUsd(row.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-muted-foreground">
        {data.byModel.map((row) => shortModel(row.model)).join(', ')}
        {data.unpricedCalls > 0 && ` · ${data.unpricedCalls} call${data.unpricedCalls === 1 ? '' : 's'} with no price`}
      </p>
    </div>
  );
}
