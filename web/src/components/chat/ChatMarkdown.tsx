import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ChatMarkdownProps {
  content: string;
}

export default function ChatMarkdown({ content }: ChatMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h3 className="mb-3 text-lg font-semibold text-foreground">{children}</h3>,
        h2: ({ children }) => <h4 className="mb-2 mt-4 text-base font-semibold text-foreground first:mt-0">{children}</h4>,
        h3: ({ children }) => <h5 className="mb-2 mt-3 text-sm font-semibold text-foreground first:mt-0">{children}</h5>,
        p: ({ children }) => <p className="mb-3 leading-relaxed last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="my-2 list-disc pl-6">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal pl-6">{children}</ol>,
        li: ({ children }) => <li className="my-1 leading-relaxed">{children}</li>,
        code: ({ className, children, ...props }) => {
          const isInline = !className;
          return isInline ? (
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]" {...props}>
              {children}
            </code>
          ) : (
            <code className={`block font-mono text-sm ${className || ''}`} {...props}>
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <pre className="my-3 overflow-x-auto rounded-lg border bg-card p-4 text-sm">{children}</pre>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-3 rounded-r-md border-l-[3px] border-primary bg-primary/5 py-1 pl-4">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="my-3 overflow-x-auto">
            <table className="w-full border-collapse text-sm">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-border bg-muted/50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {children}
          </th>
        ),
        td: ({ children }) => <td className="border border-border px-3 py-2">{children}</td>,
        a: ({ href, children }) => (
          <a href={href} className="underline hover:opacity-80" target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        hr: () => <hr className="my-4 border-border" />,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
