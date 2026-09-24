import { Link, useRouterState } from '@tanstack/react-router';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { useAgent } from '@/lib/agent-context';
import { navItemFor } from '@/lib/nav';
import { threadDisplayName } from '@/lib/thread-name';
import { useCurrentConversation } from '@/hooks/use-current-conversation';

/** Where you are: the agent, the page, and on the Chat page the conversation on screen. */
export function AppBreadcrumb() {
  const agent = useAgent();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const conversation = useCurrentConversation();
  const page = navItemFor(pathname);
  const isRoot = pathname === '/';

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem>
          {isRoot ? (
            <BreadcrumbPage>{agent.name}</BreadcrumbPage>
          ) : (
            <BreadcrumbLink render={<Link to="/" />}>{agent.name}</BreadcrumbLink>
          )}
        </BreadcrumbItem>
        {!isRoot && page && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {conversation ? (
                <BreadcrumbLink render={<Link to={page.to} />}>{page.label}</BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{page.label}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </>
        )}
        {conversation && (
          <>
            <BreadcrumbSeparator className="hidden sm:block" />
            <BreadcrumbItem className="hidden min-w-0 sm:inline-flex">
              <BreadcrumbPage data-testid="breadcrumb-conversation" className="max-w-[40ch] truncate">
                {threadDisplayName(conversation)}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
