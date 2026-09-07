import { Check, RotateCcw } from 'lucide-react';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { revisionMethod, revisionTitle } from '@/lib/revision-labels';
import type { DocumentRevisionSummary } from '@/types';

export function RevisionListItem({
  revision,
  selected,
  current,
  onSelect,
}: {
  revision: DocumentRevisionSummary;
  selected: boolean;
  current: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-revision-id={revision.id}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'w-full rounded-lg border px-3 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring',
        selected
          ? 'border-primary/50 bg-primary/10'
          : 'border-transparent hover:bg-accent',
      )}
    >
      <span className="flex items-start gap-2 text-sm font-medium leading-5 text-foreground">
        {revision.method === 'rollback' && (
          <RotateCcw className="mt-0.5 size-3.5 shrink-0 text-primary" />
        )}
        <span className="line-clamp-2 break-words">
          {revisionTitle(revision)}
        </span>
      </span>
      <span className="mt-1.5 flex flex-wrap items-center gap-x-1 text-xs text-foreground/70">
        {revision.actor === 'user' ? 'You' : 'Agent'} ·{' '}
        {revisionMethod(revision)} ·{' '}
        <time
          dateTime={revision.createdAt}
          title={new Date(revision.createdAt).toLocaleString()}
        >
          {formatRelativeTime(revision.createdAt)}
        </time>
      </span>
      {current && (
        <span className="mt-2 flex items-center gap-1 text-xs text-primary">
          <Check className="size-3" /> Matches current document
        </span>
      )}
    </button>
  );
}
