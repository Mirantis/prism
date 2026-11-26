import { formatShare, formatValue, seriesColor } from './chart-scale';

/** The point on the unit circle at `turn` of a full turn, clockwise from the top. */
function point(turn: number): string {
  const angle = turn * 2 * Math.PI - Math.PI / 2;
  return `${Math.cos(angle)} ${Math.sin(angle)}`;
}

/** One slice per category, clockwise from the top, each the size of its share of the total. */
export function PiePlot({ categories, values }: { categories: string[]; values: number[] }) {
  const total = values.reduce((sum, value) => sum + value, 0);
  let start = 0;
  return (
    <svg viewBox="-1.05 -1.05 2.1 2.1" className="size-40 shrink-0">
      {values.map((value, index) => {
        const share = value / total;
        const from = start;
        start += share;
        const label = `${categories[index]}: ${formatValue(value)} (${formatShare(share)})`;
        const paint = { fill: seriesColor(index), stroke: 'var(--secondary)', strokeWidth: 0.02, strokeLinejoin: 'round' as const };
        if (share >= 1) {
          return (
            <circle key={categories[index]} r={1} {...paint}>
              <title>{label}</title>
            </circle>
          );
        }
        return (
          <path key={categories[index]} d={`M 0 0 L ${point(from)} A 1 1 0 ${share > 0.5 ? 1 : 0} 1 ${point(start)} Z`} {...paint}>
            <title>{label}</title>
          </path>
        );
      })}
    </svg>
  );
}
