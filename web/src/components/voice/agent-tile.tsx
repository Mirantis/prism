import { cn } from '@/lib/utils';

interface AgentTileProps {
  name: string;
  /** Lights the tile up and shows the speaking badge while the agent is heard. */
  speaking: boolean;
  /** The small corner version, laid over the screen. */
  compact?: boolean;
}

/** The agent's tile: a dark video-call tile with its initial, lit while it speaks. */
export function AgentTile({ name, speaking, compact = false }: AgentTileProps) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div
      data-speaking={speaking || undefined}
      className={cn(
        'relative flex aspect-video w-full items-center justify-center rounded-xl bg-zinc-800 transition-shadow duration-200',
        compact && 'rounded-lg',
        speaking &&
          (compact
            ? 'ring-2 ring-sky-400 shadow-[0_0_24px_rgba(56,189,248,0.35)]'
            : 'ring-4 ring-sky-400 shadow-[0_0_40px_rgba(56,189,248,0.35)]'),
      )}
    >
      <div
        className={cn(
          'flex items-center justify-center rounded-full bg-violet-600 font-medium text-white',
          compact ? 'size-12 text-xl' : 'size-24 text-4xl sm:size-32 sm:text-5xl',
        )}
      >
        {initial}
      </div>
      <span
        className={cn(
          'absolute bottom-2 left-2 rounded-md bg-black/50 px-2 py-0.5 text-white',
          compact ? 'text-xs' : 'bottom-3 left-3 py-1 text-sm',
        )}
      >
        {name}
      </span>
      {speaking && <SpeakingBadge compact={compact} />}
    </div>
  );
}

/** The three bouncing bars a video call shows on whoever is talking. */
function SpeakingBadge({ compact }: { compact: boolean }) {
  return (
    <div
      aria-label="Speaking"
      className={cn(
        'absolute flex items-end justify-center gap-[3px] rounded-full bg-sky-500',
        compact ? 'right-2 top-2 size-6 pb-1.5' : 'right-3 top-3 size-8 pb-2',
      )}
    >
      <style>{`
        @keyframes voice-bar {
          0%, 100% { height: 4px; }
          50% { height: ${compact ? 10 : 14}px; }
        }
      `}</style>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="block h-1 w-[3px] rounded-full bg-white"
          style={{ animation: `voice-bar 0.9s ease-in-out ${i * 0.15}s infinite both` }}
        />
      ))}
    </div>
  );
}
