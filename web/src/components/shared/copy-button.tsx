import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Put text on the clipboard. The async clipboard exists only on a secure origin, so a runtime
 * reached over plain HTTP on a LAN address copies through a selected off-screen textarea.
 */
async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('copy refused');
}

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
      await writeClipboard(typeof text === 'function' ? text() : text);
    } catch {
      // Refused by the browser, for example without permission; the text stays selectable
      // on screen.
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
