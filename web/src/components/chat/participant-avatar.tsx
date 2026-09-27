import { cn } from '@/lib/utils';

/** Someone else sharing the agent: their initial, beside what they say, where the agent has its mark. */
export default function ParticipantAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground',
        className,
      )}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
