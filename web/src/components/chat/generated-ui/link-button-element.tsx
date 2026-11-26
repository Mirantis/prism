import { ExternalLink } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';

/** A link that opens in a new tab. A press on the block's buttons leaves it working. */
export function LinkButtonElement({ label, url }: { label: string; url: string }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
      {label}
      <ExternalLink aria-hidden="true" />
      <span className="sr-only">, opens in a new tab</span>
    </a>
  );
}
