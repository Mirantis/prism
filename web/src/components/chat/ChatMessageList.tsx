import { useRef, useEffect } from 'react';
import ChatMessage from './ChatMessage';
import ChatTypingIndicator from './ChatTypingIndicator';
import ChatWelcome from './ChatWelcome';
import type { ConversationMessage } from '@/types';

interface ChatMessageListProps {
  messages: ConversationMessage[];
  agentName: string;
  isTyping: boolean;
  isLoading: boolean;
  onOpenComputerHelp: (id: string) => void;
}

export default function ChatMessageList({
  messages,
  agentName,
  isTyping,
  isLoading,
  onOpenComputerHelp,
}: ChatMessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isTyping]);

  const isEmpty = messages.length === 0 && !isLoading;

  return (
    <div className="flex-1 overflow-y-auto" data-testid="chat-messages">
      {isEmpty ? (
        <ChatWelcome />
      ) : (
        // One readable column, however wide the window: a reply that runs the full width of
        // a large screen is a line the eye cannot follow back.
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
          {messages.map((msg) => (
            <ChatMessage
              key={msg.id}
              message={msg}
              agentName={agentName}
              onOpenComputerHelp={onOpenComputerHelp}
            />
          ))}
          {isTyping && <ChatTypingIndicator />}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}
