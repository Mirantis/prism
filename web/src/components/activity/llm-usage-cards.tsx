import { useQuery } from '@tanstack/react-query';
import { Coins, ArrowDownToLine, ArrowUpFromLine, Zap } from 'lucide-react';
import { StatCard } from '@/components/shared/stat-card';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { formatTokens } from '@/lib/format';

const WINDOW_HOURS = 24;

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
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard
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
        tone="primary"
        isLoading={loading}
      />
      <StatCard
        testId="activity-input-tokens"
        label="Input"
        value={figure(usage?.inputTokens)}
        detail={exact(usage?.inputTokens, 'tokens, cache included')}
        icon={ArrowDownToLine}
        tone="teal"
        isLoading={loading}
      />
      <StatCard
        testId="activity-output-tokens"
        label="Output"
        value={figure(usage?.outputTokens)}
        detail={exact(usage?.outputTokens, 'tokens generated')}
        icon={ArrowUpFromLine}
        tone="success"
        isLoading={loading}
      />
      <StatCard
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
        tone="warning"
        isLoading={loading}
      />
    </div>
  );
}
