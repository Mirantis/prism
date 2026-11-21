import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { runtimeApi, type SpendRange } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { formatUsd, unnamedSource } from '@/lib/spending';
import type { SourcedSpendCategory } from '@/types';

/** One category's spend per scheduled task, webhook or goal. */
export function SpendingSourceList({ category, range }: { category: SourcedSpendCategory; range: SpendRange }) {
  const agent = useAgent();
  const { data, isPending, isError } = useQuery({
    queryKey: ['spending-sources', agent.agentId, category, range.from, range.to],
    queryFn: () => runtimeApi.spendingSources(category, range),
  });

  if (isPending) return <Skeleton className="ml-6 h-4 w-48" />;
  if (isError) return <p className="pl-6 text-xs text-muted-foreground">Could not be read.</p>;

  return (
    <ul className="space-y-1 pl-6" data-testid="spending-source-list">
      {data.sources.map((source) => (
        <li key={source.sourceId ?? 'earlier'} className="flex items-center justify-between gap-3 text-xs" data-testid="spending-source">
          <span className={source.name ? 'truncate text-foreground' : 'truncate text-muted-foreground italic'}>
            {source.name ?? unnamedSource(category, source.sourceId)}
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {source.calls} call{source.calls === 1 ? '' : 's'} ·{' '}
            <span className="text-foreground">{formatUsd(source.costUsd)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
