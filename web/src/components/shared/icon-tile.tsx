import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';
import { TONE_TILE, type Tone } from '@/lib/tones';

const SIZES = {
  sm: 'size-8 rounded-lg [&_svg]:size-4',
  md: 'size-10 rounded-xl [&_svg]:size-[18px]',
  lg: 'size-12 rounded-2xl [&_svg]:size-5',
};

/** An icon on a tinted square: the visual anchor of a row, a card or an empty state. */
export function IconTile({
  icon: Icon,
  tone = 'neutral',
  size = 'sm',
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  tone?: Tone;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center ring-1 ring-inset',
        SIZES[size],
        TONE_TILE[tone],
        className,
      )}
    >
      <Icon />
    </span>
  );
}
