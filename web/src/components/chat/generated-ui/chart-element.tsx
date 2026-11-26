import type { GeneratedUiChart } from '@/types';
import { BarPlot } from './bar-plot';
import { CartesianFrame } from './cartesian-frame';
import { ChartLegend, type LegendItem } from './chart-legend';
import { formatShare, formatValue, niceScale, seriesColor } from './chart-scale';
import { LinePlot } from './line-plot';
import { PiePlot } from './pie-plot';

/** The chart's numbers as a table, for a screen reader. */
function ChartTable({ chart }: { chart: GeneratedUiChart }) {
  return (
    <table className="sr-only">
      <caption>{chart.title}</caption>
      <thead>
        <tr>
          <th scope="col">{chart.xLabel ?? 'Category'}</th>
          {chart.series.map((series) => (
            <th key={series.name} scope="col">
              {series.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {chart.categories.map((category, at) => (
          <tr key={category}>
            <th scope="row">{category}</th>
            {chart.series.map((series) => (
              <td key={series.name}>{formatValue(series.values[at])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PieChart({ chart }: { chart: GeneratedUiChart }) {
  const values = chart.series[0].values;
  const total = values.reduce((sum, value) => sum + value, 0);
  const items: LegendItem[] = chart.categories.map((category, index) => ({
    label: category,
    color: seriesColor(index),
    detail: `${formatValue(values[index])} · ${formatShare(values[index] / total)}`,
  }));
  return (
    <div className="flex flex-wrap items-center gap-4">
      <PiePlot categories={chart.categories} values={values} />
      <ChartLegend items={items} className="min-w-0 flex-1 flex-col items-start" />
    </div>
  );
}

/** A bar, line, area or pie chart. The drawing is for the eye; a screen reader reads the table. */
export function ChartElement({ chart }: { chart: GeneratedUiChart }) {
  const scale = niceScale(chart.series.flatMap((series) => series.values));
  const legend = chart.series.map((series, index) => ({ label: series.name, color: seriesColor(index) }));
  return (
    <div className="space-y-2" data-testid="generated-ui-chart">
      <p aria-hidden="true" className="font-medium break-words text-strong">
        {chart.title}
      </p>
      <div aria-hidden="true" className="space-y-2">
        {chart.kind === 'pie' ? (
          <PieChart chart={chart} />
        ) : (
          <>
            {legend.length > 1 && <ChartLegend items={legend} />}
            <CartesianFrame scale={scale} categories={chart.categories} xLabel={chart.xLabel} yLabel={chart.yLabel}>
              {chart.kind === 'bar' ? <BarPlot chart={chart} scale={scale} /> : <LinePlot chart={chart} scale={scale} area={chart.kind === 'area'} />}
            </CartesianFrame>
          </>
        )}
      </div>
      <ChartTable chart={chart} />
    </div>
  );
}
