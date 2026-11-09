import { useId, type ReactNode, type Ref } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * One answer row: a native radio or checkbox, its label, detail and "Recommended" tag.
 * `children` sit inside the row, under the label. A selected row has a 1 px border and
 * an inset shadow, so that it is the same size as a resting row.
 */
export function QuestionCardOption({
  type,
  name,
  label,
  detail,
  recommended = false,
  checked,
  inputRef,
  onChange,
  children,
}: {
  type: 'radio' | 'checkbox';
  name: string;
  label: string;
  detail?: string;
  recommended?: boolean;
  checked: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onChange: () => void;
  children?: ReactNode;
}) {
  const detailId = useId();
  const isRadio = type === 'radio';
  return (
    <div
      className={cn(
        'group/option min-h-12 rounded-lg border border-control-border transition-colors hover:bg-muted/30',
        'has-[:checked]:border-primary has-[:checked]:bg-primary/12 has-[:checked]:shadow-[inset_0_0_0_0.5px_var(--primary)] has-[:checked]:hover:bg-primary/12',
        'has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring has-[input:focus-visible]:ring-offset-2 has-[input:focus-visible]:ring-offset-secondary has-[input:focus-visible]:outline-hidden',
        'has-[:disabled]:opacity-60 has-[:disabled]:hover:bg-transparent',
      )}
    >
      <label className="flex cursor-pointer items-start gap-3 px-3.5 py-3" data-testid="question-card-option">
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
            'mt-0.5 flex size-[1.125rem] shrink-0 items-center justify-center border-[1.5px] border-muted-foreground peer-checked:border-primary',
            '[&>*]:opacity-0 peer-checked:[&>*]:opacity-100',
            isRadio ? 'rounded-full' : 'rounded-sm text-primary-foreground peer-checked:bg-primary',
          )}
        >
          {isRadio ? (
            <span className="size-2 rounded-full bg-primary forced-color-adjust-none" />
          ) : (
            <Check className="size-3" strokeWidth={3} />
          )}
        </span>
        <span className="min-w-0 flex-1">
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
      {children}
    </div>
  );
}
