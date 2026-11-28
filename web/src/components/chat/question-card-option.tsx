import { useId, type Ref } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * One answer row: a native radio or checkbox, the number key that chooses it, its label,
 * detail and "Recommended" tag. A chosen checkbox shows a check in place of its number.
 */
export function QuestionCardOption({
  type,
  name,
  number,
  label,
  detail,
  recommended = false,
  checked,
  inputRef,
  onChange,
  onReselect,
}: {
  type: 'radio' | 'checkbox';
  name: string;
  number: number;
  label: string;
  detail?: string;
  recommended?: boolean;
  checked: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onChange: () => void;
  /** A click or Space on a radio that is already checked, which fires no change. */
  onReselect?: () => void;
}) {
  const detailId = useId();
  return (
    <label
      className={cn(
        'group/option flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-muted/40',
        'has-[:checked]:bg-primary/12 has-[:checked]:hover:bg-primary/12',
        'has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring has-[input:focus-visible]:outline-hidden',
        'has-[:disabled]:cursor-default has-[:disabled]:opacity-60 has-[:disabled]:hover:bg-transparent',
      )}
      data-testid="question-card-option"
    >
      <input
        ref={inputRef}
        type={type}
        name={name}
        checked={checked}
        onChange={onChange}
        onClick={() => {
          if (type === 'radio' && checked) onReselect?.();
        }}
        aria-label={recommended ? `${label}, Recommended` : label}
        aria-describedby={detail ? detailId : undefined}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-md border border-control-border text-xs font-medium text-muted-foreground tabular-nums',
          'peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground',
        )}
      >
        {type === 'checkbox' && checked ? <Check className="size-3.5" strokeWidth={3} /> : number}
      </span>
      <span className="min-w-0 flex-1 pt-px">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 text-[0.9375rem] leading-[1.375rem] break-words text-strong">{label}</span>
          {recommended && (
            <span className="inline-flex h-5 items-center rounded-full bg-primary/15 px-2 text-xs font-medium text-primary-soft">
              Recommended
            </span>
          )}
        </span>
        {detail && (
          <span
            id={detailId}
            className="mt-0.5 block text-[0.8125rem] leading-[1.125rem] break-words text-muted-foreground group-hover/option:text-foreground group-has-[:checked]/option:text-foreground"
          >
            {detail}
          </span>
        )}
      </span>
    </label>
  );
}
