import type { ComponentType, ReactNode } from 'react';
import { Link, type LinkProps } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { Tone } from '@/lib/tones';
import { IconTile } from './icon-tile';

/**
 * One figure with its label and a line of detail. With `to`, the whole card is a link to the
 * page where the figure is managed.
 */
export function StatCard({
  label,
  value,
  detail,
  icon,
  tone = 'neutral',
  to,
  isLoading = false,
  testId,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon: ComponentType<{ className?: string }>;
  tone?: Tone;
  to?: LinkProps['to'];
  isLoading?: boolean;
  testId?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
        <IconTile icon={icon} tone={tone} />
      </div>
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-3 w-28" />
        </div>
      ) : (
        <div className="min-w-0">
          <div className="truncate text-2xl font-semibold tracking-tight text-strong tabular-nums" data-testid={testId}>
            {value}
          </div>
          {detail && <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>}
        </div>
      )}
      {to && (
        <ArrowUpRight
          aria-hidden="true"
          className="absolute right-4 bottom-4 size-4 text-muted-foreground opacity-0 transition-opacity group-hover/stat:opacity-100"
        />
      )}
    </>
  );

  const shell =
    'group/stat relative flex flex-col justify-between gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-all';

  if (!to) return <div className={shell}>{body}</div>;
  return (
    <Link
      to={to}
      className={cn(
        shell,
        'outline-none hover:-translate-y-0.5 hover:bg-card/80 hover:ring-foreground/20 hover:shadow-lg hover:shadow-black/20 focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {body}
    </Link>
  );
}
