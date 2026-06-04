import { useEffect, useRef } from 'react';
import type { ConversationMessage } from '../lib/runtime';
import type { ChatStatus } from '../hooks/use-chat';
import { ChatMessage } from './ChatMessage';

interface Props {
  messages: ConversationMessage[];
  status: ChatStatus;
}

export function ChatMessageList({ messages, status }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the latest message as new ones arrive.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, status]);

  if (messages.length === 0) {
    return (
      <div className="message-list message-list-empty">
        <p>Send a message to start chatting with your agent.</p>
      </div>
    );
  }

  return (
    <div className="message-list">
      {messages.map((m) => (
        <ChatMessage key={m.id} message={m} />
      ))}
      {status === 'thinking' ? (
        <div className="message message-agent">
          <div className="message-role">Agent</div>
          <div className="message-body thinking">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
          </div>
        </div>
      ) : null}
      <div ref={bottomRef} />
    </div>
  );
}
