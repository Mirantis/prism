import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Copy some text to the clipboard, with a tick for a moment after it lands. */
export function CopyButton({
  text,
  label = 'Copy',
  className,
  testId,
}: {
  /** The text, or a function that reads it at the moment of the press. */
  text: string | (() => string);
  label?: string;
  className?: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
    } catch {
      // The clipboard is unavailable in an insecure context or without permission; the
      // text stays selectable on screen.
      return;
    }
    setCopied(true);
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Copied' : label}
      aria-label={copied ? 'Copied' : label}
      data-testid={testId}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}
