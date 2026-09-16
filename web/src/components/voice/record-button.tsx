import { Circle, Square } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RecordButtonProps {
  recording: boolean;
  /** How long the running recording has been going, shown while it runs. */
  elapsedMs: number;
  disabled?: boolean;
  onToggle: () => void;
}

/** `0:07` — the elapsed time on the button while a recording runs. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Screen recording control with a visible action label. */
export function RecordButton({ recording, elapsedMs, disabled, onToggle }: RecordButtonProps) {
  return (
    <button
      type="button"
      aria-label={recording ? 'Stop recording your screen' : 'Record your screen'}
      aria-pressed={recording}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'flex h-10 items-center justify-center gap-2 rounded-lg border border-white/10 px-3 text-sm font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-50',
        recording ? 'bg-rose-500/20 text-rose-200 hover:bg-rose-500/30' : 'bg-zinc-800 hover:bg-zinc-700',
      )}
    >
      {recording ? <Square className="size-4 fill-current" /> : <Circle className="size-4 fill-current" />}
      <span>{recording ? `Stop recording · ${clock(elapsedMs)}` : 'Record'}</span>
    </button>
  );
}
