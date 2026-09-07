import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { diffLines } from '@/lib/line-diff';

const MARKERS = { same: ' ', add: '+', remove: '-' } as const;

const TONES = {
  same: 'text-foreground/75',
  add: 'bg-emerald-500/10 text-emerald-300',
  remove: 'bg-rose-500/10 text-rose-300',
} as const;

/** The line difference between two versions of one identity document. */
export function RevisionDiff({
  older,
  newer,
  olderLabel = 'Selected version',
  newerLabel = 'Current document',
}: {
  older: string;
  newer: string;
  olderLabel?: string;
  newerLabel?: string;
}) {
  const lines = useMemo(() => diffLines(older, newer), [older, newer]);

  if (!lines.some((line) => line.kind !== 'same')) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-background/30 px-4 py-10 text-center text-sm text-foreground/75">
        No differences. These versions have the same content.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap gap-x-5 gap-y-2 border-b border-border bg-background/30 px-4 py-3 text-xs">
        <span className="text-rose-300">− {olderLabel}</span>
        <span className="text-emerald-300">+ {newerLabel}</span>
      </div>
      <pre
        aria-label="Line difference"
        className="max-h-96 overflow-auto bg-background/30 py-3 font-mono text-xs leading-6"
      >
        {lines.map((line, index) => (
          <div key={index} className={cn('flex gap-3 px-3', TONES[line.kind])}>
            <span className="w-14 shrink-0 select-none text-right text-muted-foreground">
              {line.oldLine ?? '·'} {line.newLine ?? '·'}
            </span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{`${MARKERS[line.kind]} ${line.text}`}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
