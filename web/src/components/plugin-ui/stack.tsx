import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const GAPS = {
  none: 'gap-0',
  sm: 'gap-2',
  md: 'gap-4',
  lg: 'gap-6',
} as const;

export interface StackProps {
  children?: ReactNode;
  gap?: keyof typeof GAPS;
}

/**
 * Vertical layout with a spacing step.
 *
 * A plugin page cannot use a utility class of its own — Tailwind builds its
 * stylesheet by reading this app's source, which a plugin is not part of — so
 * the spacing a page needs comes from components like this one.
 */
export function Stack({ children, gap = 'md' }: StackProps) {
  return <div className={cn('flex flex-col', GAPS[gap])}>{children}</div>;
}
