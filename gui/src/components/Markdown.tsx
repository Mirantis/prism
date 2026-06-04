import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Minimal GitHub-flavored markdown renderer for agent messages, matching the
 * web app's approach. Links open in the user's browser rather than navigating
 * the app webview.
 */
export function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
