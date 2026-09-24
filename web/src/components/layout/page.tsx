import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** The readable column every settings page sits in, however wide the window. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-6xl space-y-8 pb-6', className)}>{children}</div>;
}
