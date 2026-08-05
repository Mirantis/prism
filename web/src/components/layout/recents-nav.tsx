import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { SquarePen } from 'lucide-react';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useAgent } from '@/lib/agent-context';
import { runtimeApi } from '@/api/runtime-client';
import { threadDisplayName } from '@/lib/thread-name';

/**
 * "Recents" — lists the agent's conversation threads (newest first) in the
 * sidebar. Database threads only; Slack threads are filtered out server-side.
 * Each row links to /chat/<threadId>. Rendered by AppSidebar only while the
 * Chat page is open. The pen action next to the label starts a fresh
 * conversation (the server reuses the newest thread while it's still empty).
 */
export function RecentsNav() {
  const agent = useAgent();
  const { threadId: routeThreadId } = useParams({ strict: false });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [createError, setCreateError] = useState<string | null>(null);
  const { data: threads, isLoading } = useQuery({
    queryKey: ['threads', agent.agentId, 'recents'],
    queryFn: () =>
      runtimeApi.listThreads(agent.agentId, agent.userId, {
        threadSource: 'DATABASE',
        limit: 100,
      }),
  });

  const createThread = useMutation({
    mutationFn: () => runtimeApi.createThread(agent.agentId, agent.userId),
    onSuccess: (thread) => {
      queryClient.invalidateQueries({ queryKey: ['threads', agent.agentId, 'recents'] });
      queryClient.invalidateQueries({ queryKey: ['threads', agent.agentId, 'latest'] });
      setCreateError(null);
      navigate({ to: '/chat/$threadId', params: { threadId: thread.id } });
    },
    // Without this the click is a silent no-op — nothing navigates and nothing
    // is said, which reads as a dead button and invites repeated clicking.
    onError: (e: unknown) =>
      setCreateError(e instanceof Error ? e.message : 'Could not start a conversation'),
  });

  // Highlight the current conversation: the thread in the URL, or — at bare
  // /chat — the latest (first row, since the server returns createdAt desc).
  const selectedThreadId = routeThreadId ?? threads?.[0]?.id;

  return (
    <SidebarGroup data-testid="recents">
      <SidebarGroupLabel>Recents</SidebarGroupLabel>
      <SidebarGroupAction
        data-testid="new-thread"
        aria-label="New conversation"
        title="New conversation"
        disabled={createThread.isPending}
        onClick={() => createThread.mutate()}
      >
        <SquarePen />
      </SidebarGroupAction>
      {createError && (
        <span data-testid="new-thread-error" className="px-2 text-xs text-destructive">
          {createError}
        </span>
      )}
      <SidebarMenu>
        {threads?.map((thread) => {
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
                className="block truncate rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground"
              >
                {name}
              </Link>
            </SidebarMenuItem>
          );
        })}
        {!isLoading && threads && threads.length === 0 && (
          <SidebarMenuItem>
            <span className="block px-2 py-1.5 text-sm text-muted-foreground">
              No conversations yet
            </span>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
