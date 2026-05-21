import { memo } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Bot } from 'lucide-react';
import ChatMarkdown from './ChatMarkdown';
import ChatToolCalls from './ChatToolCalls';
import type { ConversationMessage } from '@/types';

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
    return (
      <div className="flex justify-center">
        <div
          className={`max-w-[85%] rounded-lg px-4 py-2 text-center text-sm italic ${
            isError
              ? 'border border-destructive/40 bg-destructive/10 text-destructive'
              : 'text-muted-foreground'
          }`}
        >
          <ChatMarkdown content={message.content} />
        </div>
      </div>
    );
  }

  if (message.role === 'USER') {
    return (
      <div className="group flex justify-end gap-3">
        <div className="flex max-w-[85%] flex-col items-end gap-1">
          <div className="rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground">
            <ChatMarkdown content={message.content} />
          </div>
          <span className="px-1 text-[10px] text-muted-foreground">{time}</span>
        </div>
      </div>
    );
  }

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
        <div className="text-sm text-foreground break-words overflow-hidden">
          <ChatMarkdown content={message.content} />
        </div>
        {message.toolCalls && message.toolCalls.length > 0 && <ChatToolCalls toolCalls={message.toolCalls} />}
      </div>
    </div>
  );
});

export default ChatMessage;
