import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { formatUsd } from '@/lib/spending';
import type { SpendTotals } from '@/types';

/**
 * One ranked row: a name, its amount and share, and a bar sized against the largest
 * row. With `details`, the row expands to show them.
 */
export function SpendingBreakdownRow({
  label,
  hint,
  totals,
  share,
  barWidth,
  details,
  mono = false,
}: {
  label: string;
  hint?: string;
  totals: SpendTotals;
  /** The row's share of the whole, 0–1. */
  share: number;
  /** The bar's width against the largest row, 0–1. */
  barWidth: number;
  details?: ReactNode;
  mono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const head = (
    <>
      <div className="flex items-center gap-2">
        {details && (
          <ChevronRight
            aria-hidden="true"
            className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          />
        )}
        <span className={cn('min-w-0 flex-1 truncate text-left text-sm text-foreground', mono && 'font-mono text-xs')} title={hint}>
          {label}
        </span>
        <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{Math.round(share * 100)}%</span>
        <span className="w-20 shrink-0 text-right text-sm font-medium text-strong tabular-nums">{formatUsd(totals.costUsd)}</span>
      </div>
      <div className={cn('mt-1.5 h-1.5 overflow-hidden rounded-full bg-foreground/8', details && 'ml-5.5')}>
        <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(barWidth * 100, totals.costUsd > 0 ? 1 : 0)}%` }} />
      </div>
    </>
  );

  if (!details) {
    return (
      <li className="px-2 py-1.5" data-testid="spending-breakdown-row">
        {head}
      </li>
    );
  }
  return (
    <li data-testid="spending-breakdown-row">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50">{head}</CollapsibleTrigger>
        <CollapsibleContent className="pt-1 pb-2">{open && details}</CollapsibleContent>
      </Collapsible>
    </li>
  );
}
