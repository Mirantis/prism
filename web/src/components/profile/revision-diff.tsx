import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { diffLines } from '@/lib/line-diff';

const MARKERS = { same: ' ', add: '+', remove: '-' } as const;

const TONES = {
  same: 'text-muted-foreground',
  add: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  remove: 'bg-destructive/10 text-destructive',
} as const;

/** The line difference between two versions of one identity document. */
export function RevisionDiff({ older, newer }: { older: string; newer: string }) {
  const lines = useMemo(() => diffLines(older, newer), [older, newer]);

  if (!lines.some((line) => line.kind !== 'same')) {
    return <p className="mt-3 text-xs text-muted-foreground">These two versions are identical.</p>;
  }

  return (
    <pre
      aria-label="Line difference"
      className="mt-3 max-h-80 overflow-auto rounded-md border border-border p-3 font-mono text-xs"
    >
      {lines.map((line, index) => (
        <div key={index} className={cn('flex gap-3', TONES[line.kind])}>
          <span className="w-14 shrink-0 select-none text-right text-muted-foreground">
            {line.oldLine ?? '·'} {line.newLine ?? '·'}
          </span>
          <span className="whitespace-pre-wrap">{`${MARKERS[line.kind]} ${line.text}`}</span>
        </div>
      ))}
    </pre>
  );
}
