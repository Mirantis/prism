import { CalendarDays, History, Wallet } from 'lucide-react';
import { StatCard } from '@/components/shared/stat-card';
import { formatUsd, monthTotals, periodLabel, type MonthTotals } from '@/lib/spending';
import type { PeriodSpend } from '@/types';

/** "+18% vs. Oct 1–21": this month so far against the same days of last month. */
function comparison({ thisMonth, lastMonthToDate, dayOfMonth, lastMonthStart }: MonthTotals): string {
  if (!lastMonthStart) return '';
  const days = `${periodLabel('month', lastMonthStart)} 1–${dayOfMonth}`;
  if (lastMonthToDate === 0) return thisMonth === 0 ? 'Nothing spent yet' : `Nothing spent ${days}`;
  const change = Math.round(((thisMonth - lastMonthToDate) / lastMonthToDate) * 100);
  if (change === 0) return `Same as ${days}`;
  return `${change > 0 ? '+' : '−'}${Math.abs(change)}% vs. ${days}`;
}

/** Today's, this month's and last month's spend, from daily periods that end today. */
export function SpendingTiles({ days, isLoading }: { days: PeriodSpend[] | undefined; isLoading: boolean }) {
  const totals = monthTotals(days ?? []);
  const today = days?.at(-1);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
      <StatCard
        testId="spending-today"
        label="Today"
        value={formatUsd(totals.today)}
        detail={today ? periodLabel('day', today.start, 'long') : undefined}
        icon={CalendarDays}
        tone="primary"
        isLoading={isLoading}
      />
      <StatCard
        testId="spending-this-month"
        label="This month"
        value={formatUsd(totals.thisMonth)}
        detail={comparison(totals)}
        icon={Wallet}
        tone="teal"
        isLoading={isLoading}
      />
      <StatCard
        testId="spending-last-month"
        label="Last month"
        value={formatUsd(totals.lastMonth)}
        detail={totals.lastMonthStart ? periodLabel('month', totals.lastMonthStart, 'long') : undefined}
        icon={History}
        tone="neutral"
        isLoading={isLoading}
      />
    </div>
  );
}
