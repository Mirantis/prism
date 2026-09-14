import { ScreenShare, ScreenShareOff } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ShareButtonProps {
  sharing: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

/** Screen sharing control with a visible action label. */
export function ShareButton({ sharing, disabled, onToggle }: ShareButtonProps) {
  return (
    <button
      type="button"
      aria-label={sharing ? 'Stop sharing your screen' : 'Share your screen'}
      aria-pressed={sharing}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'flex h-10 items-center justify-center gap-2 rounded-lg border border-white/10 px-3 text-sm font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-50',
        sharing ? 'bg-sky-500/20 text-sky-200 hover:bg-sky-500/30' : 'bg-zinc-800 hover:bg-zinc-700',
      )}
    >
      {sharing ? <ScreenShareOff className="size-4" /> : <ScreenShare className="size-4" />}
      <span>{sharing ? 'Stop sharing' : 'Share screen'}</span>
    </button>
  );
}
