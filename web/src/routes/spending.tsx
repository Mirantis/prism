import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CircleDollarSign, X } from 'lucide-react';
import { Page } from '@/components/layout/page';
import { PageHeader } from '@/components/layout/page-header';
import { SectionHeader } from '@/components/layout/section-header';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SpendingBreakdown } from '@/components/spending/spending-breakdown';
import { SpendingChart } from '@/components/spending/spending-chart';
import { SpendingThreadSheet } from '@/components/spending/spending-thread-sheet';
import { SpendingThreadsTable } from '@/components/spending/spending-threads-table';
import { SpendingTiles } from '@/components/spending/spending-tiles';
import { runtimeApi, type SpendRange } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { MONTH_TOTALS_DAYS, PERIOD_COUNT, periodLabel } from '@/lib/spending';
import type { SpendPeriodLength } from '@/types';

export const Route = createFileRoute('/spending')({
  component: SpendingPage,
});

const REFRESH_MS = 60_000;

const PERIOD_NOUN: Record<SpendPeriodLength, string> = { day: 'day', week: 'week', month: 'month' };

/** "On Wed, Nov 18", "In the week of Nov 16" or "In November 2026". */
function selectedPhrase(length: SpendPeriodLength, start: string): string {
  const label = periodLabel(length, start, 'long');
  if (length === 'day') return `On ${label}`;
  if (length === 'week') return `In the w${label.slice(1)}`;
  return `In ${label}`;
}

function SpendingPage() {
  const agent = useAgent();
  const [length, setLength] = useState<SpendPeriodLength>('day');
  const [selected, setSelected] = useState<string | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);

  // The tiles' days also serve the chart's day view: the last 30 of them.
  const days = useQuery({
    queryKey: ['spending-periods', agent.agentId, 'day', MONTH_TOTALS_DAYS],
    queryFn: () => runtimeApi.spendingPeriods('day', MONTH_TOTALS_DAYS),
    refetchInterval: REFRESH_MS,
  });
  const longer = useQuery({
    queryKey: ['spending-periods', agent.agentId, length, PERIOD_COUNT[length]],
    queryFn: () => runtimeApi.spendingPeriods(length, PERIOD_COUNT[length]),
    enabled: length !== 'day',
    refetchInterval: REFRESH_MS,
  });
  const periods = length === 'day' ? days.data?.periods.slice(-PERIOD_COUNT.day) : longer.data?.periods;

  const selectedPeriod = periods?.find((p) => p.start === selected) ?? null;
  const range: SpendRange | null = useMemo(() => {
    if (selectedPeriod) return { from: selectedPeriod.from, to: selectedPeriod.to };
    if (!periods?.length) return null;
    return { from: periods[0].from, to: periods[periods.length - 1].to };
  }, [periods, selectedPeriod]);

  const summary = useQuery({
    queryKey: ['spending-summary', agent.agentId, range?.from, range?.to],
    queryFn: () => runtimeApi.spendingSummary(range!),
    enabled: range !== null,
    refetchInterval: REFRESH_MS,
  });

  const changeLength = (next: SpendPeriodLength) => {
    setLength(next);
    setSelected(null);
  };

  // No call in two months reads as a new agent. One idle that long with older spend
  // also lands here, and its month view is one click away once it spends again.
  const nothingYet = days.data !== undefined && days.data.periods.every((p) => p.calls === 0);
  const rangeLabel = selectedPeriod
    ? selectedPhrase(length, selectedPeriod.start)
    : `In the last ${PERIOD_COUNT[length]} ${PERIOD_NOUN[length]}s`;

  return (
    <Page>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Spending
            <Badge variant="secondary" title="Token counts times each model's list price. Your bill can differ.">
              Estimate
            </Badge>
          </span>
        }
        description="What the agent spends on models: its own, the coding agent's and the voice models."
      />

      <SpendingTiles days={days.data?.periods} isLoading={days.isPending} />

      {nothingYet ? (
        <EmptyState
          testId="spending-empty"
          icon={CircleDollarSign}
          title="Nothing spent yet"
          description="Spending appears here after the agent's first reply."
          className="rounded-xl bg-card ring-1 ring-foreground/10"
        />
      ) : (
        <>
          <section className="space-y-3">
            <SectionHeader
              title="Spending over time"
              description={`Per ${PERIOD_NOUN[length]}, in ${days.data?.timezone ?? 'the agent’s'} time. Select a bar to see what it was spent on.`}
              actions={
                <Tabs value={length} onValueChange={(value) => changeLength(value as SpendPeriodLength)}>
                  <TabsList>
                    <TabsTrigger value="day">Day</TabsTrigger>
                    <TabsTrigger value="week">Week</TabsTrigger>
                    <TabsTrigger value="month">Month</TabsTrigger>
                  </TabsList>
                </Tabs>
              }
            />
            <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
              {periods ? (
                <SpendingChart periods={periods} length={length} selected={selected} onSelect={setSelected} />
              ) : (
                <Skeleton className="h-56 w-full" />
              )}
            </div>
          </section>

          {selectedPeriod && (
            <div>
              <Button variant="secondary" size="sm" onClick={() => setSelected(null)} data-testid="spending-period-filter">
                Showing {periodLabel(length, selectedPeriod.start, 'long')}
                <X aria-hidden="true" className="size-3.5" />
              </Button>
            </div>
          )}

          <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <section className="space-y-3">
              <SectionHeader title="Where it went" description={`${rangeLabel}.`} />
              {range && <SpendingBreakdown summary={summary.data} range={range} isLoading={summary.isPending} />}
            </section>

            <section className="space-y-3">
              <SectionHeader title="Top conversations" description={`By spend, ${rangeLabel.charAt(0).toLowerCase()}${rangeLabel.slice(1)}. Select one to see each message’s cost.`} />
              {range && <SpendingThreadsTable range={range} total={summary.data?.costUsd ?? 0} onOpen={setOpenThread} />}
            </section>
          </div>
        </>
      )}

      <SpendingThreadSheet threadId={openThread} onClose={() => setOpenThread(null)} />
    </Page>
  );
}
