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

const ROUTE_TITLES: Record<string, string> = {
  '/': 'Overview',
  '/chat': 'Chat',
  '/channels': 'Channels',
  '/cron': 'Scheduled Tasks',
  '/webhooks': 'Webhooks',
  '/scratchpad': 'Scratchpad',
  '/profile': 'Profile',
  '/activity': 'Activity',
};

function titleFor(pathname: string): string {
  if (pathname in ROUTE_TITLES) return ROUTE_TITLES[pathname];
  const match = Object.entries(ROUTE_TITLES).find(
    ([path]) => path !== '/' && pathname.startsWith(path),
  );
  return match ? match[1] : '';
}

export function AppBreadcrumb() {
  const agent = useAgent();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const title = titleFor(pathname);
  const isRoot = pathname === '/';

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          {isRoot ? (
            <BreadcrumbPage>{agent.name}</BreadcrumbPage>
          ) : (
            <BreadcrumbLink render={<Link to="/" />}>{agent.name}</BreadcrumbLink>
          )}
        </BreadcrumbItem>
        {!isRoot && title && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{title}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
