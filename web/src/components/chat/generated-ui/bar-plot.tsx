import type { GeneratedUiChart } from '@/types';
import { formatValue, fromTop, seriesColor, type Scale } from './chart-scale';

/** Grouped bars, one group per category. A negative value hangs below the zero line. */
export function BarPlot({ chart, scale }: { chart: GeneratedUiChart; scale: Scale }) {
  return (
    <div className="absolute inset-0 flex">
      {chart.categories.map((category, at) => (
        <div key={category} className="flex h-full min-w-0 flex-1 justify-center">
          {/* The group takes the middle four fifths of its own category; a percentage padding would be of the whole plot. */}
          <div className="flex h-full w-4/5 justify-center gap-[2px]">
            {chart.series.map((series, index) => {
              const value = series.values[at];
              const top = fromTop(scale, Math.max(value, 0));
              const bottom = fromTop(scale, Math.min(value, 0));
              return (
                <div key={series.name} className="relative h-full max-w-6 min-w-[2px] flex-1">
                  <span
                    title={`${series.name}, ${category}: ${formatValue(value)}`}
                    className={`absolute inset-x-0 ${value < 0 ? 'rounded-b-[4px]' : 'rounded-t-[4px]'}`}
                    style={{ top: `${top}%`, height: `${bottom - top}%`, backgroundColor: seriesColor(index) }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
