import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { GeneratedUiButtonStyle } from '@/types';

const LOOK: Record<GeneratedUiButtonStyle | 'plain', { variant: 'default' | 'destructive' | 'outline'; className?: string }> = {
  primary: { variant: 'default', className: 'bg-primary-strong hover:bg-primary-strong-hover' },
  danger: { variant: 'destructive' },
  plain: { variant: 'outline' },
};

/** A button whose press becomes the person's message. The pressed one stays at full strength with a check. */
export function ButtonElement({
  label,
  style,
  disabled,
  sending,
  pressed,
  describedBy,
  onPress,
}: {
  label: string;
  style: GeneratedUiButtonStyle | undefined;
  disabled: boolean;
  sending: boolean;
  pressed: boolean;
  describedBy: string | undefined;
  onPress: () => void;
}) {
  const look = LOOK[style ?? 'plain'];
  return (
    <Button
      type="button"
      size="lg"
      variant={look.variant}
      className={cn('max-w-full whitespace-normal', look.className, pressed && 'disabled:opacity-100')}
      disabled={disabled}
      aria-describedby={describedBy}
      data-pressed={pressed || undefined}
      onClick={onPress}
    >
      {sending && <Loader2 aria-hidden="true" className="animate-spin" />}
      {pressed && <Check aria-hidden="true" />}
      {label}
    </Button>
  );
}
