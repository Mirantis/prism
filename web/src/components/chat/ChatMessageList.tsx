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
}

export default function ChatMessageList({ messages, agentName, isTyping, isLoading }: ChatMessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isTyping]);

  const isEmpty = messages.length === 0 && !isLoading;

  return (
    <div className="flex-1 overflow-y-auto">
      {isEmpty ? (
        <ChatWelcome />
      ) : (
        <div className="space-y-6 px-4 py-6">
          {messages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} agentName={agentName} />
          ))}
          {isTyping && <ChatTypingIndicator />}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}
