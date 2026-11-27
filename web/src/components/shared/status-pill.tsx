import { cn } from '@/lib/utils';
import { agentStatusLabel, agentStatusTone, TONE_DOT } from '@/lib/tones';

/** What the agent is doing right now, as a dot and a word. */
export function StatusPill({ status, className }: { status: string; className?: string }) {
  const tone = agentStatusTone(status);
  return (
    <span
      data-testid="agent-status"
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full bg-muted/40 px-2.5 text-xs font-medium text-strong ring-1 ring-border ring-inset',
        className,
      )}
    >
      <span className="relative flex size-2">
        {status === 'RUNNING' && (
          <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', TONE_DOT[tone])} />
        )}
        <span className={cn('relative inline-flex size-2 rounded-full', TONE_DOT[tone])} />
      </span>
      {agentStatusLabel(status)}
    </span>
  );
}
