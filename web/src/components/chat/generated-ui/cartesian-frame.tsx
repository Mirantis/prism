import type { ReactNode } from 'react';
import { formatTick, fromTop, type Scale } from './chart-scale';

const PLOT_HEIGHT = 192;

/** The value axis, grid and category labels around a bar, line or area plot. */
export function CartesianFrame({
  scale,
  categories,
  xLabel,
  yLabel,
  children,
}: {
  scale: Scale;
  categories: string[];
  xLabel?: string;
  yLabel?: string;
  children: ReactNode;
}) {
  return (
    <div>
      {yLabel && <p className="mb-1 text-[11px] text-muted-foreground">{yLabel}</p>}
      <div className="flex gap-2">
        <div className="relative w-10 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums" style={{ height: PLOT_HEIGHT }}>
          {scale.ticks.map((tick) => (
            <span key={tick} className="absolute right-0 -translate-y-1/2" style={{ top: `${fromTop(scale, tick)}%` }}>
              {formatTick(tick)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative" style={{ height: PLOT_HEIGHT }}>
            {scale.ticks.map((tick) => (
              <div
                key={tick}
                className={`absolute inset-x-0 border-t ${tick === 0 ? 'border-foreground/25' : 'border-foreground/8'}`}
                style={{ top: `${fromTop(scale, tick)}%` }}
              />
            ))}
            {children}
          </div>
          <div className="mt-1.5 flex text-[11px] text-muted-foreground">
            {categories.map((category) => (
              <span key={category} className="min-w-0 flex-1 truncate px-0.5 text-center" title={category}>
                {category}
              </span>
            ))}
          </div>
          {xLabel && <p className="mt-1 text-center text-[11px] text-muted-foreground">{xLabel}</p>}
        </div>
      </div>
    </div>
  );
}
