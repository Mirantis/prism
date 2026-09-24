import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { IconTile } from './icon-tile';

/** What a list shows when it has nothing in it: what belongs here, and how to add the first one. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  testId,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn('flex flex-col items-center justify-center gap-4 px-6 py-12 text-center', className)}
    >
      <IconTile icon={icon} size="lg" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-strong">{title}</p>
        {description && <p className="mx-auto max-w-md text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}
