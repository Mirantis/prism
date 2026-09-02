import { Mic, MicOff } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MuteButtonProps {
  muted: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

/** A round microphone toggle: gray while live, red with a crossed mic while muted. */
export function MuteButton({ muted, disabled, onToggle }: MuteButtonProps) {
  return (
    <button
      type="button"
      aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
      aria-pressed={muted}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'flex size-14 items-center justify-center rounded-full text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-50',
        muted ? 'bg-red-600 hover:bg-red-500' : 'bg-zinc-700 hover:bg-zinc-600',
      )}
    >
      {muted ? <MicOff className="size-6" /> : <Mic className="size-6" />}
    </button>
  );
}
