import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Bot } from 'lucide-react';

export default function ChatTypingIndicator() {
  return (
    <div className="flex gap-3" data-testid="chat-typing-indicator">
      <Avatar size="sm">
        <AvatarFallback>
          <Bot className="size-3.5" />
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-col gap-2 pt-1">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-3 w-32" />
      </div>
    </div>
  );
}
