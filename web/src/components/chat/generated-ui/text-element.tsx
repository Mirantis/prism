import type { Attachment } from '@/types';
import ChatMarkdown from '../ChatMarkdown';

/** Markdown, drawn as a reply's text is. */
export function TextElement({ text, attachments }: { text: string; attachments: Attachment[] | null | undefined }) {
  return (
    <div className="text-[0.9375rem] leading-relaxed break-words text-foreground">
      <ChatMarkdown content={text} attachments={attachments} />
    </div>
  );
}
