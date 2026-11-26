import type { GeneratedUiChart } from '@/types';
import { formatValue, fromTop, seriesColor, type Scale } from './chart-scale';

/** One line per series, each point at the middle of its category. An area plot fills down to zero. */
export function LinePlot({ chart, scale, area }: { chart: GeneratedUiChart; scale: Scale; area: boolean }) {
  const count = chart.categories.length;
  const x = (at: number) => ((at + 0.5) / count) * 100;
  const zero = fromTop(scale, 0);
  return (
    <>
      <svg className="absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
        {chart.series.map((series, index) => {
          const points = series.values.map((value, at) => `${x(at)},${fromTop(scale, value)}`).join(' ');
          const color = seriesColor(index);
          return (
            <g key={series.name}>
              {area && <polygon points={`${x(0)},${zero} ${points} ${x(count - 1)},${zero}`} fill={color} fillOpacity={0.18} />}
              <polyline
                points={points}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
      </svg>
      {chart.series.flatMap((series, index) =>
        series.values.map((value, at) => (
          <span
            key={`${series.name}-${at}`}
            title={`${series.name}, ${chart.categories[at]}: ${formatValue(value)}`}
            className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-secondary"
            style={{ left: `${x(at)}%`, top: `${fromTop(scale, value)}%`, backgroundColor: seriesColor(index) }}
          />
        )),
      )}
    </>
  );
}
