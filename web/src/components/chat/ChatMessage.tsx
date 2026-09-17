import { ChatComputerHelp } from '@/components/computer/chat-computer-help';
import type { ComputerHelp } from '@/types';
import { memo } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Bot } from 'lucide-react';
import ChatMarkdown from './ChatMarkdown';
import ChatToolCalls from './ChatToolCalls';
import { MessageAttachmentChip } from './ChatAttachmentChip';
import type { ConversationMessage } from '@/types';

function AttachmentChips({ message }: { message: ConversationMessage }) {
  if (!message.attachments || message.attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {message.attachments.map((a) => (
        <MessageAttachmentChip key={a.id} attachment={a} />
      ))}
    </div>
  );
}

interface ChatMessageProps {
  message: ConversationMessage;
  agentName: string;
}

const ChatMessage = memo(function ChatMessage({ message, agentName }: ChatMessageProps) {
  const isError = message.role === 'SYSTEM' && message.id.startsWith('error-');
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (message.role === 'SYSTEM') {
    // A one-line note ("Running skill…") reads as an aside: centered, italic,
    // out of the way. Anything multi-line is structured output from a slash
    // command — a list of plugins, skills, goals — and centering or
    // italicizing that makes it unreadable, so it gets a normal block.
    const isBlock = message.content.trim().includes('\n');
    // Built as one non-overlapping set rather than layered conditionals: two
    // competing `bg-*`/`border-*` classes on the same element resolve by
    // stylesheet order, not by which appears last in the string.
    const shape = isBlock ? 'w-full text-left' : 'text-center italic';
    const skin = isError
      ? 'border border-destructive/40 bg-destructive/10 text-destructive'
      : isBlock
        ? 'border bg-card text-foreground'
        : 'text-muted-foreground';
    return (
      <div className={`flex ${isBlock ? 'justify-start' : 'justify-center'}`}>
        <div className={`max-w-[85%] rounded-lg px-4 py-2 text-sm ${shape} ${skin}`}>
          <ChatMarkdown content={message.content} />
        </div>
      </div>
    );
  }

  if (message.role === 'USER') {
    const hasText = message.content.trim().length > 0;
    return (
      <div className="group flex justify-end gap-3">
        <div className="flex max-w-[85%] flex-col items-end gap-1">
        <AttachmentChips message={message} />
          {hasText && (
            <div className="rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground">
              <ChatMarkdown content={message.content} />
            </div>
          )}
          <span className="px-1 text-[10px] text-muted-foreground">{time}</span>
        </div>
      </div>
    );
  }

  const help = message.blocks?.filter((block): block is ComputerHelp => block !== null && typeof block === 'object' && 'type' in block && block.type === 'computer_help') ?? [];
  return (
    <div className="group flex gap-3">
      <Avatar size="sm" className="mt-0.5 shrink-0">
        <AvatarFallback>
          <Bot className="size-3.5" />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-muted-foreground">{agentName}</span>
          <span className="text-[10px] text-muted-foreground">{time}</span>
        </div>
        {help.length === 0 && <div className="text-sm text-foreground break-words overflow-hidden">
          <ChatMarkdown content={message.content} />
        </div>}
        {help.map((item) => <ChatComputerHelp key={item.id} help={item} />)}
        <AttachmentChips message={message} />
        {message.toolCalls && message.toolCalls.length > 0 && <ChatToolCalls toolCalls={message.toolCalls} />}
      </div>
    </div>
  );
});

export default ChatMessage;
