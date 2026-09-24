import { isValidElement, useRef, type ReactNode } from 'react';
import { CopyButton } from '@/components/shared/copy-button';

/** The language a fenced block declares, from the `language-*` class markdown gives its code. */
function languageOf(children: ReactNode): string | null {
  if (!isValidElement<{ className?: string }>(children)) return null;
  const match = /language-([\w+-]+)/.exec(children.props.className ?? '');
  return match ? match[1] : null;
}

/** A fenced code block in a message: its language, a copy button, and the code. */
export default function CodeBlock({ children }: { children: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const language = languageOf(children);

  return (
    <div className="group/code my-3 overflow-hidden rounded-xl bg-(--lds-color-code-bg) ring-1 ring-border">
      <div className="flex h-9 items-center justify-between border-b border-border/70 bg-muted/20 pr-1 pl-4">
        <span data-testid="code-language" className="font-mono text-[11px] text-muted-foreground">
          {language ?? 'text'}
        </span>
        {/* Markdown ends a block's code with a newline, which a pasted command should not carry. */}
        <CopyButton
          text={() => (preRef.current?.textContent ?? '').replace(/\n$/, '')}
          label="Copy code"
          testId="code-copy"
        />
      </div>
      <pre ref={preRef} className="overflow-x-auto p-4 text-[13px] leading-6">
        {children}
      </pre>
    </div>
  );
}
