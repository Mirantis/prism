import { ScreenShare, ScreenShareOff } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ShareButtonProps {
  sharing: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

/** A round share toggle: gray to start sharing the screen, lit blue with a stop icon while sharing. */
export function ShareButton({ sharing, disabled, onToggle }: ShareButtonProps) {
  return (
    <button
      type="button"
      aria-label={sharing ? 'Stop sharing your screen' : 'Share your screen'}
      aria-pressed={sharing}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'flex size-14 items-center justify-center rounded-full text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-50',
        sharing ? 'bg-sky-500 hover:bg-sky-400' : 'bg-zinc-700 hover:bg-zinc-600',
      )}
    >
      {sharing ? <ScreenShareOff className="size-6" /> : <ScreenShare className="size-6" />}
    </button>
  );
}
