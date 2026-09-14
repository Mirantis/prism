import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const GAPS = {
  none: 'gap-0',
  sm: 'gap-2',
  md: 'gap-4',
  lg: 'gap-6',
} as const;

/**
 * Column counts are whole class strings rather than an interpolated number:
 * Tailwind decides which rules to generate by reading this file, so a class it
 * cannot see written out is never built.
 */
const COLUMNS = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
} as const;

export interface GridProps {
  children?: ReactNode;
  columns?: keyof typeof COLUMNS;
  gap?: keyof typeof GAPS;
}

/** Responsive grid: the requested columns on a wide window, fewer as it narrows. */
export function Grid({ children, columns = 2, gap = 'md' }: GridProps) {
  return <div className={cn('grid', COLUMNS[columns], GAPS[gap])}>{children}</div>;
}
