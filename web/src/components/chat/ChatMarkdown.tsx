import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './code-block';

interface ChatMarkdownProps {
  content: string;
}

export default function ChatMarkdown({ content }: ChatMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h3 className="mt-5 mb-3 text-lg font-semibold text-strong first:mt-0">{children}</h3>,
        h2: ({ children }) => <h4 className="mt-4 mb-2 text-base font-semibold text-strong first:mt-0">{children}</h4>,
        h3: ({ children }) => <h5 className="mt-3 mb-2 text-sm font-semibold text-strong first:mt-0">{children}</h5>,
        p: ({ children }) => <p className="mb-3 leading-relaxed last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="my-2 list-disc pl-6">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal pl-6">{children}</ol>,
        li: ({ children }) => <li className="my-1 leading-relaxed">{children}</li>,
        code: ({ className, children, ...props }) => {
          const isInline = !className;
          return isInline ? (
            <code className="rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[0.85em] text-strong" {...props}>
              {children}
            </code>
          ) : (
            <code className={`block font-mono ${className || ''}`} {...props}>
              {children}
            </code>
          );
        },
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        blockquote: ({ children }) => (
          <blockquote className="my-3 rounded-r-md border-l-[3px] border-primary bg-primary/5 py-1 pl-4">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="my-3 overflow-x-auto rounded-xl ring-1 ring-border">
            <table className="w-full border-collapse text-sm">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border-b border-border bg-muted/30 px-3 py-2 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {children}
          </th>
        ),
        td: ({ children }) => <td className="border-t border-border/60 px-3 py-2">{children}</td>,
        a: ({ href, children }) => (
          <a
            href={href}
            className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            target="_blank"
            rel="noopener noreferrer"
          >
            {children}
          </a>
        ),
        hr: () => <hr className="my-4 border-border" />,
        strong: ({ children }) => <strong className="font-semibold text-strong">{children}</strong>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
