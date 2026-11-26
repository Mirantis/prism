// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { GeneratedUiChart } from '@/types';
import { ChartElement } from './chart-element';
import { niceScale } from './chart-scale';

const BARS: GeneratedUiChart = {
  kind: 'bar',
  title: 'Balance per month',
  xLabel: 'Month',
  yLabel: 'EUR',
  categories: ['Jan', 'Feb'],
  series: [
    { name: 'Team A', values: [40, -20] },
    { name: 'Team B', values: [10, 30] },
  ],
};

const PIE: GeneratedUiChart = {
  kind: 'pie',
  title: 'Traffic by region',
  categories: ['EU', 'US', 'Asia'],
  series: [{ name: 'Requests', values: [50, 30, 20] }],
};

/** A bar's top and height, as percentages of the plot. */
const extent = (title: string) => {
  const style = (screen.getByTitle(title) as HTMLElement).style;
  return { top: parseFloat(style.top), height: parseFloat(style.height) };
};

describe('ChartElement', () => {
  it('draws one bar per value, grouped by category, with a legend for several series', () => {
    render(<ChartElement chart={BARS} />);
    for (const title of ['Team A, Jan: 40', 'Team B, Jan: 10', 'Team A, Feb: -20', 'Team B, Feb: 30']) {
      expect(screen.getByTitle(title)).toBeTruthy();
    }
    expect(screen.getAllByRole('listitem', { hidden: true }).map((item) => item.textContent)).toEqual(['Team A', 'Team B']);
    expect(screen.getByText('EUR')).toBeTruthy();
  });

  it('draws a negative bar below the zero line and a positive one above it', () => {
    render(<ChartElement chart={BARS} />);
    const positive = extent('Team A, Jan: 40');
    const negative = extent('Team A, Feb: -20');
    expect(positive.top + positive.height).toBeCloseTo(negative.top);
    expect(positive.height).toBeCloseTo(negative.height * 2);
  });

  it('gives a single series no legend', () => {
    render(<ChartElement chart={{ ...BARS, series: [BARS.series[0]] }} />);
    expect(screen.queryByRole('list', { hidden: true })).toBeNull();
  });

  it('gives a screen reader the numbers as a table', () => {
    render(<ChartElement chart={BARS} />);
    const table = screen.getByRole('table', { name: 'Balance per month' });
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Month', 'Team A', 'Team B']);
    const feb = within(table).getByRole('rowheader', { name: 'Feb' }).closest('tr')!;
    expect(within(feb).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['-20', '30']);
  });

  it('draws one pie slice per category, with each share in the legend', () => {
    const { container } = render(<ChartElement chart={PIE} />);
    expect(container.querySelectorAll('svg path')).toHaveLength(3);
    expect(screen.getByText('EU: 50 (50%)')).toBeTruthy();
    expect(screen.getByText('Asia: 20 (20%)')).toBeTruthy();
    const legend = screen.getAllByRole('listitem', { hidden: true }).map((item) => item.textContent);
    expect(legend).toEqual(['EU50 · 50%', 'US30 · 30%', 'Asia20 · 20%']);
  });

  it('draws a pie of one category as a whole circle', () => {
    const { container } = render(<ChartElement chart={{ ...PIE, categories: ['EU'], series: [{ name: 'Requests', values: [5] }] }} />);
    expect(container.querySelectorAll('svg circle')).toHaveLength(1);
    expect(screen.getByText('EU: 5 (100%)')).toBeTruthy();
  });

  it('draws a line and a point per value, and an area fills under its line', () => {
    const line = render(<ChartElement chart={{ ...BARS, kind: 'line' }} />);
    expect(line.container.querySelectorAll('polyline')).toHaveLength(2);
    expect(line.container.querySelectorAll('polygon')).toHaveLength(0);
    expect(screen.getByTitle('Team B, Feb: 30')).toBeTruthy();
    line.unmount();
    const area = render(<ChartElement chart={{ ...BARS, kind: 'area' }} />);
    expect(area.container.querySelectorAll('polygon')).toHaveLength(2);
  });
});

describe('niceScale', () => {
  it('covers every value and zero in round steps', () => {
    expect(niceScale([3, 5, 2])).toEqual({ min: 0, max: 6, ticks: [6, 4, 2, 0] });
    expect(niceScale([40, -20, 10, 30])).toEqual({ min: -20, max: 40, ticks: [40, 20, 0, -20] });
  });

  it('gives all-zero values an axis of its own', () => {
    expect(niceScale([0, 0])).toEqual({ min: 0, max: 1, ticks: [1, 0.5, 0] });
  });
});
