import type { Viewer } from '@/lib/chat-socket/protocol';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, LoaderCircle } from 'lucide-react';
import ChatMessage from './ChatMessage';
import ChatTypingIndicator from './ChatTypingIndicator';
import ChatWelcome from './ChatWelcome';
import DayDivider from './day-divider';
import { isSameDay } from '@/lib/day-label';
import type { TurnState } from '@/lib/chat-socket/protocol';
import type { TranscriptMessage } from '@/lib/chat-socket/transcript';

/** How close to the end, in pixels, still counts as reading the latest message. */
const AT_BOTTOM_PX = 120;

/** How far above the top, in pixels, older messages start to load. */
const LOAD_OLDER_PX = 600;

interface ChatMessageListProps {
  messages: TranscriptMessage[];
  agentName: string;
  /** Who this connection signed in as, undefined until the runtime has said. Other people's messages show their name. */
  viewer: Viewer | undefined;
  /** What the thread on screen is doing. */
  turnState: TurnState;
  isLoading: boolean;
  /** Whether the runtime holds messages before the first one shown. */
  hasOlder: boolean;
  isLoadingOlder: boolean;
  /** Load the page before the first message shown. */
  onLoadOlder: () => void;
  /** The conversation on screen; a change opens the new one at its end. */
  threadId?: string;
  /** Send one of the empty conversation's suggestions; absent while nothing can be sent. */
  onSuggestion?: (prompt: string) => void;
  onOpenComputerHelp: (id: string) => void;
  onRetry: (id: string) => void;
  onEdit: (id: string) => void;
}

export default function ChatMessageList({
  messages,
  agentName,
  viewer,
  turnState,
  isLoading,
  hasOlder,
  isLoadingOlder,
  onLoadOlder,
  threadId,
  onSuggestion,
  onOpenComputerHelp,
  onRetry,
  onEdit,
}: ChatMessageListProps) {
  const isWorking = turnState !== 'idle';
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const olderRef = useRef<HTMLDivElement>(null);
  // Read in the effect below, so a new message follows the reader's position at that moment.
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const first = messages[0];
  const last = messages[messages.length - 1];
  // The list's first and last message and the reader's distance from its end, as of the
  // last render or scroll.
  const placeRef = useRef<{ firstId?: string; lastId?: string; fromEnd: number }>({ fromEnd: 0 });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    placeRef.current.fromEnd = el.scrollHeight - el.scrollTop;
    const next = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
    atBottomRef.current = next;
    setAtBottom(next);
  };

  // Older messages arrive above the reader, who keeps the message they were reading in
  // place. The browser's own scroll anchoring is off, so only this moves the list.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const before = placeRef.current;
    if (before.firstId && first?.id !== before.firstId && last?.id === before.lastId) {
      el.scrollTop = el.scrollHeight - before.fromEnd;
    }
    placeRef.current = { firstId: first?.id, lastId: last?.id, fromEnd: el.scrollHeight - el.scrollTop };
  });

  // A new message scrolls into view only for a reader already at the end, or for the
  // message they just sent. Somebody reading further up keeps their place, and so does
  // somebody reading older messages as they load.
  const sentByMe = last?.role === 'USER';
  useEffect(() => {
    if (atBottomRef.current || sentByMe) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [last?.id, turnState, sentByMe]);

  // A conversation opens at its end, whatever the last one was scrolled to. Keyed on the
  // conversation itself: two cached threads can hold the same number of messages, and a
  // cached one never passes through an empty list on the way in. It jumps again, without
  // animation, when the history arrives, so the top of the list never shows and starts
  // loading older pages.
  const isEmpty = messages.length === 0 && !isLoading;
  useEffect(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    endRef.current?.scrollIntoView();
  }, [threadId, isLoading]);

  // Older messages load as the reader nears the top. A new observer for each first
  // message reports at once, so a list shorter than the screen keeps loading.
  useEffect(() => {
    const root = scrollRef.current;
    const target = olderRef.current;
    if (!hasOlder || !root || !target) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onLoadOlder();
      },
      { root, rootMargin: `${LOAD_OLDER_PX}px 0px 0px 0px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasOlder, first?.id, onLoadOlder]);

  return (
    <div className="relative min-h-0 flex-1">
      {/* Positioned, so absolute children such as screen-reader text stay inside the scroller. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative h-full overflow-y-auto [overflow-anchor:none]"
        data-testid="chat-messages"
      >
        {isEmpty ? (
          <ChatWelcome agentName={agentName} onSuggestion={onSuggestion} />
        ) : (
          // One readable column, however wide the window: a reply that runs the full width of
          // a large screen is a line the eye cannot follow back.
          <div className="mx-auto w-full max-w-3xl space-y-7 px-4 py-6">
            {hasOlder && (
              <div ref={olderRef} className="flex h-6 justify-center" data-testid="older-messages">
                {isLoadingOlder && (
                  <LoaderCircle aria-label="Loading older messages" className="size-4 animate-spin text-muted-foreground" />
                )}
              </div>
            )}
            {messages.map((msg, i) => (
              <Fragment key={msg.id}>
                {(i === 0 || !isSameDay(messages[i - 1].createdAt, msg.createdAt)) && (
                  <DayDivider date={msg.createdAt} />
                )}
                <ChatMessage
                  message={msg}
                  agentName={agentName}
                  viewer={viewer}
                  onOpenComputerHelp={onOpenComputerHelp}
                  onRetry={onRetry}
                  onEdit={onEdit}
                />
              </Fragment>
            ))}
            {isWorking && <ChatTypingIndicator queued={turnState === 'queued'} />}
            <div ref={endRef} />
          </div>
        )}
      </div>
      {/* The last lines fade toward the composer, so the list reads as continuing under it. */}
      {!isEmpty && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent"
        />
      )}
      {!atBottom && !isEmpty && (
        <button
          type="button"
          onClick={() => endRef.current?.scrollIntoView({ behavior: 'smooth' })}
          data-testid="jump-to-latest"
          className="absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-card px-3 text-xs font-medium text-strong shadow-lg shadow-black/30 ring-1 ring-foreground/15 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ArrowDown className="size-3.5" />
          {turnState === 'running' ? 'New reply below' : 'Jump to latest'}
        </button>
      )}
    </div>
  );
}
