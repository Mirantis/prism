import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Search, SquarePen, X } from 'lucide-react';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { useAgent } from '@/lib/agent-context';
import { runtimeApi } from '@/api/runtime-client';
import { threadDisplayName } from '@/lib/thread-name';
import { useRecentThreads } from '@/hooks/use-recent-threads';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function RecentsNav() {
  const agent = useAgent();
  const { threadId: routeThreadId } = useParams({ strict: false });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [createError, setCreateError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const { setOpenMobile } = useSidebar();
  const { data: threads, isLoading, isError, refetch } = useRecentThreads();
  const filteredThreads = threads?.filter((thread) =>
    threadDisplayName(thread).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );

  const createThread = useMutation({
    mutationFn: () => runtimeApi.createThread(agent.agentId, agent.userId),
    onSuccess: (thread) => {
      queryClient.invalidateQueries({ queryKey: ['threads', agent.agentId, 'recents'] });
      queryClient.invalidateQueries({ queryKey: ['threads', agent.agentId, 'latest'] });
      setCreateError(null);
      setSearch('');
      setOpenMobile(false);
      navigate({ to: '/chat/$threadId', params: { threadId: thread.id } });
    },
    onError: (e: unknown) =>
      setCreateError(e instanceof Error ? e.message : 'Could not start a conversation'),
  });

  // Highlight the current conversation: the thread in the URL, or — at bare
  // /chat — the latest (first row, since the server returns createdAt desc).
  const selectedThreadId = routeThreadId ?? threads?.[0]?.id;

  return (
    <SidebarGroup data-testid="recents">
      <Button
        variant="outline"
        className="mb-5 h-10 w-full justify-start"
        data-testid="new-thread"
        disabled={createThread.isPending}
        onClick={() => createThread.mutate()}
      >
        <SquarePen className="size-4" />
        {createThread.isPending ? 'Creating conversation…' : 'New conversation'}
      </Button>
      <SidebarGroupLabel>Recents</SidebarGroupLabel>
      <div className="relative mb-3">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={searchRef}
          aria-label="Search recent conversations"
          placeholder="Search conversations"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-9 pl-8 pr-8 text-xs"
        />
        {search && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear conversation search"
            className="absolute right-0.5 top-0.5 size-8"
            onClick={() => {
              setSearch('');
              searchRef.current?.focus();
            }}
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>
      {isError && (
        <div className="px-2 pb-3 text-xs text-muted-foreground">
          <p>Conversations could not be loaded.</p>
          <button
            type="button"
            className="mt-1 text-primary hover:underline"
            onClick={() => refetch()}
          >
            Try again
          </button>
        </div>
      )}
      {createError && (
        <span data-testid="new-thread-error" className="px-2 text-xs text-destructive">
          {createError}
        </span>
      )}
      <SidebarMenu>
        {filteredThreads?.map((thread) => {
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
                className="block truncate rounded-md px-2 py-2.5 transition-colors hover:bg-sidebar-accent text-sm text-sidebar-foreground/80 data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground"
              >
                {name}
              </Link>
            </SidebarMenuItem>
          );
        })}
        {!isLoading && !isError && filteredThreads?.length === 0 && (
          <SidebarMenuItem>
            <span className="block px-2 py-1.5 text-sm text-muted-foreground">
              {search.trim() ? 'No matching conversations' : 'No conversations yet'}
            </span>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
