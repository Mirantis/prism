import { Fragment, useEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import ChatMessage from './ChatMessage';
import ChatTypingIndicator from './ChatTypingIndicator';
import ChatWelcome from './ChatWelcome';
import DayDivider from './day-divider';
import { isSameDay } from '@/lib/day-label';
import type { ConversationMessage } from '@/types';

/** How close to the end, in pixels, still counts as reading the latest message. */
const AT_BOTTOM_PX = 120;

interface ChatMessageListProps {
  messages: ConversationMessage[];
  agentName: string;
  isTyping: boolean;
  isLoading: boolean;
  /** Send one of the empty conversation's suggestions; absent while nothing can be sent. */
  onSuggestion?: (prompt: string) => void;
}

export default function ChatMessageList({
  messages,
  agentName,
  isTyping,
  isLoading,
  onSuggestion,
}: ChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // Read in the effect below, so a new message follows the reader's position at that moment.
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const next = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
    atBottomRef.current = next;
    setAtBottom(next);
  };

  // A new message scrolls into view only for a reader already at the end, or for the
  // message they just sent. Somebody reading further up keeps their place.
  const last = messages[messages.length - 1];
  const sentByMe = last?.role === 'USER';
  useEffect(() => {
    if (atBottomRef.current || sentByMe) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isTyping, sentByMe]);

  // A conversation opens at its end, whatever the last one was scrolled to.
  const isEmpty = messages.length === 0 && !isLoading;
  useEffect(() => {
    if (messages.length === 0) {
      atBottomRef.current = true;
      setAtBottom(true);
    }
  }, [messages.length]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto" data-testid="chat-messages">
        {isEmpty ? (
          <ChatWelcome agentName={agentName} onSuggestion={onSuggestion} />
        ) : (
          // One readable column, however wide the window: a reply that runs the full width of
          // a large screen is a line the eye cannot follow back.
          <div className="mx-auto w-full max-w-3xl space-y-7 px-4 py-6">
            {messages.map((msg, i) => (
              <Fragment key={msg.id}>
                {(i === 0 || !isSameDay(messages[i - 1].createdAt, msg.createdAt)) && (
                  <DayDivider date={msg.createdAt} />
                )}
                <ChatMessage message={msg} agentName={agentName} />
              </Fragment>
            ))}
            {isTyping && <ChatTypingIndicator />}
            <div ref={endRef} />
          </div>
        )}
      </div>
      {!atBottom && !isEmpty && (
        <button
          type="button"
          onClick={() => endRef.current?.scrollIntoView({ behavior: 'smooth' })}
          data-testid="jump-to-latest"
          className="absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-card px-3 text-xs font-medium text-strong shadow-lg shadow-black/30 ring-1 ring-foreground/15 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ArrowDown className="size-3.5" />
          {isTyping ? 'New reply below' : 'Jump to latest'}
        </button>
      )}
    </div>
  );
}
