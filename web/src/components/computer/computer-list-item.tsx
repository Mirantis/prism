import { Link } from '@tanstack/react-router';
import { Laptop, MessageSquare, Monitor, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ComputerSummary } from '@/types';

const PLATFORMS: Record<string, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };

/** Connected, not connected, or added and never connected. */
function connectionLabel(computer: ComputerSummary): string {
  if (computer.connection === 'connected') return 'Connected';
  return computer.lastConnectedAt ? 'Not connected' : 'Never connected';
}

export function ComputerListItem({
  computer,
  selected,
  onSelect,
  onRename,
  onRemove,
}: {
  computer: ComputerSummary;
  selected: boolean;
  onSelect: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  const remote = computer.kind === 'remote';
  const connected = computer.connection === 'connected';
  const Icon = remote ? Laptop : Monitor;
  const platform = computer.platform ? PLATFORMS[computer.platform] ?? computer.platform : null;
  const detail = remote ? platform : 'The runtime’s own desktop';
  return (
    <li
      aria-label={computer.name}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex min-w-0 items-start gap-3 rounded-xl border bg-card p-3 shadow-sm',
        selected && 'border-primary/50 ring-1 ring-primary/30',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-start gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 space-y-0.5">
          <span className="block truncate text-sm font-medium">{computer.name}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={cn('size-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-muted-foreground')}
              />
              {connectionLabel(computer)}
            </span>
            {detail && <span>{detail}</span>}
          </span>
          {computer.problems.map((problem) => (
            <span key={problem.capability} className="block text-xs text-amber-600 dark:text-amber-400">
              {problem.message}
            </span>
          ))}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {computer.owner?.threadId && (
          <Link
            to="/chat/$threadId"
            params={{ threadId: computer.owner.threadId }}
            title="Open the conversation using it"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <MessageSquare className="size-3.5" /> In use
          </Link>
        )}
        {remote && (
          <>
            <Button size="icon-sm" variant="ghost" aria-label={`Rename ${computer.name}`} onClick={onRename}>
              <Pencil className="size-3.5" />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={`Remove ${computer.name}`} onClick={onRemove}>
              <Trash2 className="size-3.5" />
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
