import { useRef, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { Search, SquarePen, X } from 'lucide-react';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { threadDisplayName } from '@/lib/thread-name';
import { groupThreadsByDate } from '@/lib/thread-groups';
import { useCreateThread } from '@/hooks/use-create-thread';
import { useRecentThreads } from '@/hooks/use-recent-threads';

/** A list this long gets a filter box above it; a shorter one fits on screen as it is. */
const FILTER_FROM = 6;

/**
 * "Recents" — lists the agent's conversation threads (newest first) in the
 * sidebar, under a heading for the day each one started. Each row links to
 * /chat/<threadId>. Rendered by AppSidebar only while the Chat page is open.
 * The pen action next to the label starts a fresh conversation.
 */
export function RecentsNav() {
  const { threadId: routeThreadId } = useParams({ strict: false });
  const createThread = useCreateThread();
  const { data: threads, isLoading, isError, refetch } = useRecentThreads();
  const [filter, setFilter] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);

  // Highlight the current conversation: the thread in the URL, or — at bare
  // /chat — the latest (first row, since the server returns createdAt desc).
  const selectedThreadId = routeThreadId ?? threads?.[0]?.id;

  const needle = filter.trim().toLocaleLowerCase();
  const shown = (threads ?? []).filter(
    (thread) => !needle || threadDisplayName(thread).toLocaleLowerCase().includes(needle),
  );
  const showFilter = (threads?.length ?? 0) >= FILTER_FROM;

  return (
    <SidebarGroup data-testid="recents" className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Recents</SidebarGroupLabel>
      <SidebarGroupAction
        data-testid="new-thread"
        aria-label="New conversation"
        title="New conversation"
        disabled={createThread.isPending}
        onClick={createThread.create}
      >
        <SquarePen />
      </SidebarGroupAction>
      {createThread.error && (
        <span data-testid="new-thread-error" className="px-2 text-xs text-destructive">
          {createThread.error}
        </span>
      )}
      {showFilter && (
        <div className="relative mx-1 mt-1 mb-2">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            ref={filterRef}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.preventDefault();
                setFilter('');
              }
            }}
            aria-label="Filter conversations"
            placeholder="Filter conversations"
            data-testid="recents-filter"
            className="h-8 w-full rounded-lg bg-background/60 pr-7 pl-8 text-xs text-strong ring-1 ring-border outline-none transition-shadow placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
          />
          {filter && (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => {
                setFilter('');
                filterRef.current?.focus();
              }}
              className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-strong"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
      {isError && (
        <div data-testid="recents-error" className="px-2 py-1.5 text-xs text-muted-foreground">
          Conversations could not be loaded.{' '}
          <button type="button" onClick={() => refetch()} className="text-primary hover:underline">
            Try again
          </button>
        </div>
      )}
      {groupThreadsByDate(shown).map((group) => (
        <div key={group.label} data-testid="recents-group" data-group={group.label} className="mt-1 first-of-type:mt-0">
          <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">{group.label}</div>
          <SidebarMenu>
            {group.threads.map((thread) => {
              const name = threadDisplayName(thread);
              const selected = thread.id === selectedThreadId;
              return (
                <SidebarMenuItem key={thread.id}>
                  <Link
                    to="/chat/$threadId"
                    params={{ threadId: thread.id }}
                    data-testid="recent-thread"
                    data-active={selected ? 'true' : undefined}
                    title={name}
                    className="block truncate rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground"
                  >
                    {name}
                  </Link>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </div>
      ))}
      {!isLoading && !isError && threads && threads.length === 0 && (
        <span className="block px-2 py-1.5 text-sm text-muted-foreground">No conversations yet</span>
      )}
      {!isLoading && needle && threads && threads.length > 0 && shown.length === 0 && (
        <span data-testid="recents-no-match" className="block px-2 py-1.5 text-sm text-muted-foreground">
          No conversations match
        </span>
      )}
    </SidebarGroup>
  );
}
