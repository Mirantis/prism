/** Five hues in a fixed order, checked for color-blind separation on the card in both themes. */
const HUES = [
  'var(--chart-1)',
  'color-mix(in srgb, var(--chart-3) 79%, black)',
  'var(--chart-5)',
  'color-mix(in srgb, var(--chart-4) 75%, var(--strong))',
  'color-mix(in srgb, var(--chart-2) 82%, black)',
];

/** The color of the series or pie slice at `index`. Past the fifth, the hues repeat in a lighter, then a deeper step. */
export function seriesColor(index: number): string {
  const hue = HUES[index % HUES.length];
  const round = Math.floor(index / HUES.length);
  if (round === 0) return hue;
  return `color-mix(in srgb, ${hue} 60%, ${round === 1 ? 'var(--strong)' : 'var(--background)'})`;
}

export interface Scale {
  min: number;
  max: number;
  /** Axis values from the top down. */
  ticks: number[];
}

/** A value axis with round steps that covers every value and zero. */
export function niceScale(values: number[]): Scale {
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  if (low === high) return { min: 0, max: 1, ticks: [1, 0.5, 0] };
  const rough = (high - low) / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((size) => size >= rough)!;
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step;
  const count = Math.round((max - min) / step) + 1;
  // `+ 0` turns -0 into 0.
  const ticks = Array.from({ length: count }, (_, i) => Number((max - i * step).toPrecision(12)) + 0);
  return { min, max, ticks };
}

/** Where `value` sits on the axis, as a percentage from the top. */
export function fromTop(scale: Scale, value: number): number {
  return ((scale.max - value) / (scale.max - scale.min)) * 100;
}

const VALUE = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const TICK = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const PERCENT = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });

export const formatValue = (value: number) => VALUE.format(value);
export const formatTick = (value: number) => TICK.format(value);
export const formatShare = (share: number) => PERCENT.format(share);
