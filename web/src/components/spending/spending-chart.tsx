import { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  SPEND_KINDS,
  SPEND_KIND_FILL,
  SPEND_KIND_LABEL,
  formatUsd,
  periodLabel,
} from '@/lib/spending';
import type { PeriodSpend, SpendPeriodLength } from '@/types';

const PLOT_HEIGHT = 192;
const GRID_LINES = 4;

/** A round axis maximum at or above `max`: 1, 2 or 5 times a power of ten. */
function niceMax(max: number): number {
  if (max <= 0) return 0.01;
  const power = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 5, 10].find((f) => f * power >= max)!;
  return step * power;
}

/** Every n-th period gets a label, so labels never collide at the period count shown. */
const LABEL_EVERY: Record<SpendPeriodLength, number> = { day: 5, week: 2, month: 1 };

/** The tooltip of one period: its date, total and each kind's share. */
function PeriodTooltip({ period, length, position }: { period: PeriodSpend; length: SpendPeriodLength; position: number }) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute top-1 z-10 w-52 rounded-lg bg-popover p-3 text-xs shadow-lg ring-1 ring-foreground/10"
      // Kept inside the plot at both ends.
      style={{ left: `clamp(0px, calc(${position}% - 6.5rem), calc(100% - 13rem))` }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-strong">{periodLabel(length, period.start, 'long')}</span>
        <span className="font-semibold text-strong tabular-nums">{formatUsd(period.costUsd)}</span>
      </div>
      <ul className="mt-2 space-y-1">
        {SPEND_KINDS.filter((kind) => period.costUsdByKind[kind] > 0).map((kind) => (
          <li key={kind} className="flex items-center gap-2 text-muted-foreground">
            <span aria-hidden="true" className={cn('size-2 rounded-sm', SPEND_KIND_FILL[kind])} />
            <span className="flex-1">{SPEND_KIND_LABEL[kind]}</span>
            <span className="text-foreground tabular-nums">{formatUsd(period.costUsdByKind[kind])}</span>
          </li>
        ))}
      </ul>
      {period.unpricedCalls > 0 && (
        <p className="mt-2 text-muted-foreground">
          {period.unpricedCalls} call{period.unpricedCalls === 1 ? '' : 's'} with no price
        </p>
      )}
    </div>
  );
}

/**
 * Spend per period as stacked bars, one segment per kind. A bar is a button: a click
 * selects its period, and a second click clears it.
 */
export function SpendingChart({
  periods,
  length,
  selected,
  onSelect,
}: {
  periods: PeriodSpend[];
  length: SpendPeriodLength;
  selected: string | null;
  onSelect: (start: string | null) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...periods.map((p) => p.costUsd)));
  const ticks = Array.from({ length: GRID_LINES + 1 }, (_, i) => (max * (GRID_LINES - i)) / GRID_LINES);
  const empty = periods.every((p) => p.costUsd === 0);

  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        {SPEND_KINDS.map((kind) => (
          <li key={kind} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn('size-2.5 rounded-sm', SPEND_KIND_FILL[kind])} />
            {SPEND_KIND_LABEL[kind]}
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <div className="relative w-14 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums" style={{ height: PLOT_HEIGHT }}>
          {ticks.map((tick, i) => (
            <span key={i} className="absolute right-0 -translate-y-1/2" style={{ top: `${(i / GRID_LINES) * 100}%` }}>
              {formatUsd(tick)}
            </span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          <div className="relative" style={{ height: PLOT_HEIGHT }} data-testid="spending-chart">
            {ticks.map((_, i) => (
              <div
                key={i}
                aria-hidden="true"
                className={cn('absolute inset-x-0 border-t', i === GRID_LINES ? 'border-foreground/25' : 'border-foreground/8')}
                style={{ top: `${(i / GRID_LINES) * 100}%` }}
              />
            ))}
            {empty && (
              <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                Nothing spent in these {periods.length} {length}s.
              </p>
            )}
            <div className="absolute inset-0 flex items-end gap-[2px]">
              {periods.map((period, i) => {
                const isSelected = selected === period.start;
                const dimmed = selected !== null && !isSelected;
                return (
                  <button
                    key={period.start}
                    type="button"
                    data-testid="spending-chart-bar"
                    data-start={period.start}
                    aria-pressed={isSelected}
                    aria-label={`${periodLabel(length, period.start, 'long')}: ${formatUsd(period.costUsd)}`}
                    className="group/bar flex h-full min-w-0 flex-1 cursor-pointer items-end rounded-sm outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onSelect(isSelected ? null : period.start)}
                    onMouseEnter={() => setHovered(i)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(i)}
                    onBlur={() => setHovered(null)}
                  >
                    <span
                      className={cn(
                        'mx-auto flex w-full max-w-8 flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px] transition-opacity',
                        dimmed && 'opacity-35',
                      )}
                      style={{ height: `${(period.costUsd / max) * 100}%` }}
                    >
                      {SPEND_KINDS.filter((kind) => period.costUsdByKind[kind] > 0).map((kind) => (
                        <span
                          key={kind}
                          className={cn('w-full shrink-0', SPEND_KIND_FILL[kind])}
                          style={{ flexGrow: period.costUsdByKind[kind], flexBasis: 0 }}
                        />
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
            {hovered !== null && periods[hovered] && (
              <PeriodTooltip
                period={periods[hovered]}
                length={length}
                position={((hovered + 0.5) / periods.length) * 100}
              />
            )}
          </div>

          <div className="mt-1.5 flex gap-[2px] text-[11px] text-muted-foreground" aria-hidden="true">
            {periods.map((period, i) => (
              <span key={period.start} className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap">
                {(periods.length - 1 - i) % LABEL_EVERY[length] === 0 ? periodLabel(length, period.start) : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
