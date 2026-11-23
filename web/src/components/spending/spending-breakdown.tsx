import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { SpendRange } from '@/api/runtime-client';
import {
  SPEND_CATEGORY_HINT,
  SPEND_CATEGORY_LABEL,
  isSourcedCategory,
  shortModel,
} from '@/lib/spending';
import type { SpendBreakdown } from '@/types';
import { SpendingBreakdownRow } from './spending-breakdown-row';
import { SpendingSourceList } from './spending-source-list';
import { SpendingUnpricedNote } from './spending-unpriced-note';

type View = 'category' | 'model';

/** Where the range's spend went: one ranked row per category, or per model. */
export function SpendingBreakdown({
  summary,
  range,
  isLoading,
}: {
  summary: SpendBreakdown | undefined;
  range: SpendRange;
  isLoading: boolean;
}) {
  const [view, setView] = useState<View>('category');

  const rows =
    view === 'category'
      ? (summary?.byCategory ?? []).map((row) => ({ key: row.category, label: SPEND_CATEGORY_LABEL[row.category], hint: SPEND_CATEGORY_HINT[row.category], totals: row, category: row.category }))
      : (summary?.byModel ?? []).map((row) => ({ key: row.model, label: shortModel(row.model), hint: row.model, totals: row, category: null }));
  const total = summary?.costUsd ?? 0;
  const largest = Math.max(0, ...rows.map((row) => row.totals.costUsd));

  return (
    <div className="space-y-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <Tabs value={view} onValueChange={(value) => setView(value as View)}>
        <TabsList>
          <TabsTrigger value="category">By category</TabsTrigger>
          <TabsTrigger value="model">By model</TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="h-24" />
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">Nothing spent in this range.</p>
      ) : (
        <ul className="space-y-1" data-testid="spending-breakdown" data-view={view}>
          {rows.map((row) => (
            <SpendingBreakdownRow
              key={row.key}
              label={row.label}
              hint={row.hint}
              totals={row.totals}
              share={total > 0 ? row.totals.costUsd / total : 0}
              barWidth={largest > 0 ? row.totals.costUsd / largest : 0}
              mono={view === 'model'}
              details={row.category && isSourcedCategory(row.category) ? <SpendingSourceList category={row.category} range={range} /> : undefined}
            />
          ))}
        </ul>
      )}

      {summary && <SpendingUnpricedNote unpricedCalls={summary.unpricedCalls} />}
    </div>
  );
}
