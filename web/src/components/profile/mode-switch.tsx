import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

export type ModelMode = 'fixed' | 'auto';

const OPTIONS: { mode: ModelMode; label: string }[] = [
  { mode: 'fixed', label: 'Fixed' },
  { mode: 'auto', label: 'Auto' },
];

/**
 * Fixed | Auto as one segmented control with radio-group keyboard behavior:
 * one tab stop, and the arrow keys move to and choose the other option.
 */
export function ModeSwitch({
  value,
  onChange,
  busy,
}: {
  value: ModelMode;
  onChange: (mode: ModelMode) => void;
  /** Ignores input without disabling the buttons, so focus stays where it is. */
  busy: boolean;
}) {
  const buttons = useRef<Partial<Record<ModelMode, HTMLButtonElement | null>>>({});

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    if (busy) return;
    // Flip from the focused option, so the keys follow focus even before the
    // caller has moved `value`.
    const focused = event.target === buttons.current.auto ? 'auto' : 'fixed';
    const other: ModelMode = focused === 'fixed' ? 'auto' : 'fixed';
    buttons.current[other]?.focus();
    onChange(other);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Model selection"
      aria-busy={busy}
      onKeyDown={onKeyDown}
      className="inline-flex rounded-lg bg-muted p-[3px] text-sm"
    >
      {OPTIONS.map(({ mode, label }) => (
        <button
          key={mode}
          ref={(el) => {
            buttons.current[mode] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === mode}
          tabIndex={value === mode ? 0 : -1}
          aria-disabled={busy}
          onClick={() => {
            if (!busy) onChange(mode);
          }}
          className={cn(
            'rounded-md px-3 py-1 font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-disabled:opacity-50',
            value === mode
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
