import { AudioLines } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AgentTileProps {
  name: string;
  speaking: boolean;
  connected: boolean;
}

export function AgentTile({ name, speaking, connected }: AgentTileProps) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div data-speaking={speaking || undefined} className="flex min-w-0 items-center gap-3">
      <div className={cn(
        'flex size-10 shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-sm font-semibold text-violet-300 ring-1 ring-violet-400/25 transition-shadow',
        speaking && 'ring-2 ring-sky-400',
      )}>
        {speaking ? <AudioLines aria-label="Speaking" className="size-5 motion-safe:animate-pulse" /> : initial}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-zinc-100">{name}</p>
        <p className="text-xs text-zinc-400">{connected ? (speaking ? 'Speaking' : 'Connected to voice') : 'Voice offline'}</p>
      </div>
    </div>
  );
}
