import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  SidebarGroup,
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
 * Chat page is open.
 */
export function RecentsNav() {
  const agent = useAgent();
  const { threadId: routeThreadId } = useParams({ strict: false });
  const { data: threads, isLoading } = useQuery({
    queryKey: ['threads', agent.agentId, 'recents'],
    queryFn: () =>
      runtimeApi.listThreads(agent.agentId, agent.userId, {
        excludeExternal: true,
        limit: 100,
      }),
  });

  // Highlight the current conversation: the thread in the URL, or — at bare
  // /chat — the latest (first row, since the server returns createdAt desc).
  const selectedThreadId = routeThreadId ?? threads?.[0]?.id;

  return (
    <SidebarGroup data-testid="recents">
      <SidebarGroupLabel>Recents</SidebarGroupLabel>
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
