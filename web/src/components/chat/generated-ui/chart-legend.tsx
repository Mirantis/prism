import { cn } from '@/lib/utils';

export interface LegendItem {
  label: string;
  color: string;
  /** Shown after the label, such as a slice's value. */
  detail?: string;
}

/** The name of each series or slice beside its color. */
export function ChartLegend({ items, className }: { items: LegendItem[]; className?: string }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground', className)}>
      {items.map((item, index) => (
        <li key={index} className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: item.color }} />
          <span className="break-words">{item.label}</span>
          {item.detail && <span className="text-foreground tabular-nums">{item.detail}</span>}
        </li>
      ))}
    </ul>
  );
}
