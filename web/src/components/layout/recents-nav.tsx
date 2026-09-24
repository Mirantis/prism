import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
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
import { groupThreadsByDate } from '@/lib/thread-groups';
import { useCreateThread } from '@/hooks/use-create-thread';

/**
 * "Recents" — lists the agent's conversation threads (newest first) in the
 * sidebar, under a heading for the day each one started. Database threads
 * only; Slack threads are filtered out server-side. Each row links to
 * /chat/<threadId>. Rendered by AppSidebar only while the Chat page is open.
 * The pen action next to the label starts a fresh conversation.
 */
export function RecentsNav() {
  const agent = useAgent();
  const { threadId: routeThreadId } = useParams({ strict: false });
  const createThread = useCreateThread();
  const { data: threads, isLoading } = useQuery({
    queryKey: ['threads', agent.agentId, 'recents'],
    queryFn: () =>
      runtimeApi.listThreads(agent.agentId, agent.userId, {
        threadSource: 'DATABASE',
        limit: 100,
      }),
  });

  // Highlight the current conversation: the thread in the URL, or — at bare
  // /chat — the latest (first row, since the server returns createdAt desc).
  const selectedThreadId = routeThreadId ?? threads?.[0]?.id;

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
      {groupThreadsByDate(threads ?? []).map((group) => (
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
      {!isLoading && threads && threads.length === 0 && (
        <span className="block px-2 py-1.5 text-sm text-muted-foreground">No conversations yet</span>
      )}
    </SidebarGroup>
  );
}
