import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { SlashCommand } from './commands';

interface CommandPopupProps {
  items: SlashCommand[];
  selectedIndex: number;
  /** Click/tap a row to choose it (keyboard uses Tab/Enter via the input). */
  onSelect: (cmd: SlashCommand) => void;
}

/**
 * Slash-command suggestion list shown above the chat input when the user types
 * "/". Mirrors the TUI's CommandPopup: a filtered command list with a
 * highlighted selection driven by the input's arrow-key handler. Purely
 * presentational — keyboard navigation lives in ChatInput.
 */
export default function CommandPopup({ items, selectedIndex, onSelect }: CommandPopupProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Keep the highlighted row in view when arrow-keying through a long list.
  // Guarded — scrollIntoView isn't implemented in jsdom (unit tests).
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex]);

  if (items.length === 0) return null;

  return (
    <div
      data-testid="command-popup"
      role="listbox"
      className="absolute bottom-full left-0 z-50 mb-1 max-h-64 w-full overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
    >
      {items.map((cmd, i) => {
        const selected = i === selectedIndex;
        return (
          <button
            key={cmd.name}
            ref={selected ? selectedRef : undefined}
            type="button"
            role="option"
            aria-selected={selected}
            data-testid="command-popup-item"
            // Use onMouseDown (not onClick) so the textarea doesn't blur and
            // swallow the selection before it fires.
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(cmd);
            }}
            className={cn(
              'flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm',
              selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
            )}
          >
            <span className="font-medium">{cmd.name}</span>
            <span className="truncate text-xs text-muted-foreground">{cmd.description}</span>
          </button>
        );
      })}
    </div>
  );
}
