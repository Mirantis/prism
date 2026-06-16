import { useQuery } from '@tanstack/react-query';
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
 * Rows are display-only for now (not clickable). Rendered by AppSidebar only
 * while the Chat page is open.
 */
export function RecentsNav() {
  const agent = useAgent();
  const { data: threads, isLoading } = useQuery({
    queryKey: ['threads', agent.agentId, 'recents'],
    queryFn: () =>
      runtimeApi.listThreads(agent.agentId, agent.userId, {
        threadSource: 'DATABASE',
        limit: 100,
      }),
  });

  // The chat view always shows the latest (newest) database thread, which is
  // the first row here (server returns createdAt desc). Highlight it as the
  // current conversation, ChatGPT-style.
  const selectedThreadId = threads?.[0]?.id;

  return (
    <SidebarGroup data-testid="recents">
      <SidebarGroupLabel>Recents</SidebarGroupLabel>
      <SidebarMenu>
        {threads?.map((thread) => {
          const name = threadDisplayName(thread);
          const selected = thread.id === selectedThreadId;
          return (
            <SidebarMenuItem key={thread.id}>
              <span
                data-testid="recent-thread"
                data-active={selected ? 'true' : undefined}
                title={name}
                className="block truncate rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground"
              >
                {name}
              </span>
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
