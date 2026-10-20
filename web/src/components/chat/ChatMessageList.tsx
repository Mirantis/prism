import type { Viewer } from '@/lib/chat-socket/protocol';
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/** A message row and where it starts inside the list, which scrolling does not change. */
interface Anchor {
  row: Element;
  top: number;
}

function offsetIn(column: Element, row: Element): number {
  return row.getBoundingClientRect().top - column.getBoundingClientRect().top;
}

/**
 * The first message row that starts inside the view, found by halving the rows, or the
 * last row when the view starts inside it. A row partly in view above it counts as
 * above the anchor, so its growth is corrected too.
 */
function topRow(scroller: Element, column: Element): Anchor | null {
  const rows = column.querySelectorAll(':scope > [data-message-id]');
  const viewTop = scroller.getBoundingClientRect().top;
  let found: Element | undefined = rows[rows.length - 1];
  let low = 0;
  let high = rows.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rows[middle].getBoundingClientRect().top >= viewTop) {
      found = rows[middle];
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return found ? { row: found, top: offsetIn(column, found) } : null;
}

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
  /** Changes after a failed load of older messages, so a reader still at the top asks again. */
  olderRetries: number;
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
  olderRetries,
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
  const columnRef = useRef<HTMLDivElement>(null);
  // Read in the effect below, so a new message follows the reader's position at that moment.
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  // The message at the top of the reader's view, taken at each scroll the reader makes.
  const anchorRef = useRef<Anchor | null>(null);
  // Where the list's own correction put the scroll. Its scroll event keeps the anchor:
  // rows of the new page that now fill the top of the view are not what the reader read.
  const correctedToRef = useRef<number | null>(null);

  const first = messages[0];
  const last = messages[messages.length - 1];
  const isEmpty = messages.length === 0 && !isLoading;

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const corrected = correctedToRef.current !== null && Math.abs(el.scrollTop - correctedToRef.current) < 1;
    correctedToRef.current = null;
    if (!corrected) anchorRef.current = columnRef.current ? topRow(el, columnRef.current) : null;
    const next = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
    atBottomRef.current = next;
    setAtBottom(next);
  };

  // When rows above the message at the top of the view change height, as when an older
  // page arrives or an image in one loads, the list moves by as much. That message stays
  // where the reader left it. The browser's own scroll anchoring is off: not every
  // browser has it, and two corrections would move the list twice.
  const keepAnchor = useCallback(() => {
    const el = scrollRef.current;
    const column = columnRef.current;
    const anchor = anchorRef.current;
    if (!el || !column || !anchor?.row.isConnected) return;
    const top = offsetIn(column, anchor.row);
    if (top !== anchor.top) {
      el.scrollTop += top - anchor.top;
      correctedToRef.current = el.scrollTop;
    }
    anchor.top = top;
  }, []);
  useLayoutEffect(() => keepAnchor());
  useEffect(() => {
    const column = columnRef.current;
    if (!column) return;
    const observer = new ResizeObserver(() => keepAnchor());
    observer.observe(column);
    return () => observer.disconnect();
  }, [isEmpty, keepAnchor]);

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
  useEffect(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    endRef.current?.scrollIntoView();
    // Taken here too: a list already at its end gets no scroll event.
    const el = scrollRef.current;
    anchorRef.current = el && columnRef.current ? topRow(el, columnRef.current) : null;
  }, [threadId, isLoading]);

  // Older messages load as the reader nears the top. A new observer for each first
  // message, and after each failed load, reports at once, so a list shorter than the
  // screen keeps loading and a reader waiting at the top is answered.
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
  }, [hasOlder, first?.id, onLoadOlder, olderRetries]);

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
          <div ref={columnRef} className="mx-auto w-full max-w-3xl space-y-7 px-4 py-6">
            {hasOlder && (
              <div ref={olderRef} role="status" className="flex h-6 justify-center" data-testid="older-messages">
                {isLoadingOlder && (
                  <>
                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-muted-foreground" />
                    <span className="sr-only">Loading older messages</span>
                  </>
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
