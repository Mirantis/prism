import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const GAPS = {
  none: 'gap-0',
  sm: 'gap-2',
  md: 'gap-4',
  lg: 'gap-6',
} as const;

const ALIGN = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  baseline: 'items-baseline',
} as const;

const JUSTIFY = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
} as const;

export interface RowProps {
  children?: ReactNode;
  gap?: keyof typeof GAPS;
  align?: keyof typeof ALIGN;
  justify?: keyof typeof JUSTIFY;
  /** Wrap onto another line when the row runs out of width. */
  wrap?: boolean;
}

/** Horizontal layout. Wraps by default, so a narrow window never clips it. */
export function Row({
  children,
  gap = 'md',
  align = 'center',
  justify = 'start',
  wrap = true,
}: RowProps) {
  return (
    <div className={cn('flex', wrap && 'flex-wrap', GAPS[gap], ALIGN[align], JUSTIFY[justify])}>
      {children}
    </div>
  );
}
