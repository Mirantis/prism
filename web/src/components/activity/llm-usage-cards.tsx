import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Coins, ArrowDownToLine, ArrowUpFromLine, Zap } from 'lucide-react';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';

const WINDOW_HOURS = 24;

/** 1234567 → "1.23M", with the exact figure shown alongside it. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function UsageCard({
  testId,
  label,
  value,
  detail,
  icon: Icon,
  isLoading,
}: {
  testId: string;
  label: string;
  value: string;
  /** Visible detail under the figure, so a keyboard and a touchscreen reach it. */
  detail: string;
  icon: typeof Coins;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardDescription>{label}</CardDescription>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-7 w-20" />
        ) : (
          <>
            <div className="text-2xl font-bold" data-testid={testId}>
              {value}
            </div>
            <p className="text-xs text-muted-foreground">{detail}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Token spend over the last 24 hours, as four cards. */
export function LlmUsageCards() {
  const agent = useAgent();
  const { data: usage, isPending, isError } = useQuery({
    queryKey: ['llm-usage', agent.agentId, WINDOW_HOURS],
    queryFn: () => runtimeApi.llmUsage(WINDOW_HOURS),
    refetchInterval: 30_000,
  });

  // Skeletons only while a first read is outstanding; a read that failed shows
  // dashes.
  const loading = isPending && !isError;
  const calls = usage?.calls ?? 0;
  const unavailable = isError || !usage;

  // A cache rate means something only where the provider reported the
  // breakdown; absent, the card shows a dash.
  const noCacheDetail = usage?.cacheHitPercent == null;

  /** A figure, or a dash when the read did not land. */
  const figure = (n: number | undefined) => (unavailable ? '—' : formatTokens(n ?? 0));

  /** The exact count under an abbreviated figure, or why there isn't one. */
  const exact = (n: number | undefined, suffix: string) =>
    unavailable ? 'Could not be read' : `${(n ?? 0).toLocaleString()} ${suffix}`;

  return (
    <div className="grid gap-4 md:grid-cols-4">
      <UsageCard
        testId="activity-total-tokens"
        label="Total tokens"
        value={figure(usage?.totalTokens)}
        detail={
          unavailable
            ? 'Could not be read'
            : `${(usage?.totalTokens ?? 0).toLocaleString()} across ` +
              `${calls} model call${calls === 1 ? '' : 's'}`
        }
        icon={Coins}
        isLoading={loading}
      />
      <UsageCard
        testId="activity-input-tokens"
        label="Input"
        value={figure(usage?.inputTokens)}
        detail={exact(usage?.inputTokens, 'tokens, cache included')}
        icon={ArrowDownToLine}
        isLoading={loading}
      />
      <UsageCard
        testId="activity-output-tokens"
        label="Output"
        value={figure(usage?.outputTokens)}
        detail={exact(usage?.outputTokens, 'tokens generated')}
        icon={ArrowUpFromLine}
        isLoading={loading}
      />
      <UsageCard
        testId="activity-cache-hit-rate"
        label="Cache hit rate"
        value={unavailable || noCacheDetail ? '—' : `${usage?.cacheHitPercent}%`}
        detail={
          unavailable
            ? 'Could not be read'
            : noCacheDetail
              ? 'Not reported by this provider'
              : `${(usage?.cacheReadTokens ?? 0).toLocaleString()} of ` +
                `${((usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0) + (usage?.noCacheTokens ?? 0)).toLocaleString()} read from cache`
        }
        icon={Zap}
        isLoading={loading}
      />
    </div>
  );
}
