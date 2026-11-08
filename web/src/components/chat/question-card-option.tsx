import { useId, type Ref } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/** One answer row: a native radio or checkbox, its label, detail and "Recommended" tag. */
export function QuestionCardOption({
  type,
  name,
  label,
  detail,
  recommended = false,
  checked,
  inputRef,
  onChange,
}: {
  type: 'radio' | 'checkbox';
  name: string;
  label: string;
  detail?: string;
  recommended?: boolean;
  checked: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onChange: () => void;
}) {
  const detailId = useId();
  return (
    <label
      className={cn(
        'flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50',
        'has-[:checked]:bg-primary/10 has-[:checked]:hover:bg-primary/10',
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
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
        aria-label={recommended ? `${label}, Recommended` : label}
        aria-describedby={detail ? detailId : undefined}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex size-4.5 shrink-0 items-center justify-center border border-muted-foreground bg-background text-primary-foreground',
          'peer-checked:border-primary peer-checked:bg-primary [&>svg]:opacity-0 peer-checked:[&>svg]:opacity-100',
          type === 'radio' ? 'rounded-full' : 'rounded-sm',
        )}
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
      <span className="min-w-0 flex-1">
        {/* The tag sits under the label in a narrow card or at a high zoom. */}
        <span className="flex flex-col items-start gap-1 @[38rem]:flex-row @[38rem]:flex-wrap @[38rem]:items-center @[38rem]:gap-x-2">
          <span className="min-w-0 break-words text-foreground">{label}</span>
          {recommended && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs leading-none font-semibold text-primary">
              Recommended
            </span>
          )}
        </span>
        {detail && (
          <span id={detailId} className="mt-0.5 block text-xs break-words text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
    </label>
  );
}
