import { Mic, MicOff } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MuteButtonProps {
  muted: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

/** Microphone control with a visible action label. */
export function MuteButton({ muted, disabled, onToggle }: MuteButtonProps) {
  return (
    <button
      type="button"
      aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
      aria-pressed={muted}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'flex h-10 items-center justify-center gap-2 rounded-lg border border-white/10 px-3 text-sm font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-50',
        muted ? 'bg-rose-500/15 text-rose-200 hover:bg-rose-500/25' : 'bg-zinc-800 hover:bg-zinc-700',
      )}
    >
      {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      <span>{muted ? 'Unmute' : 'Mute'}</span>
    </button>
  );
}
