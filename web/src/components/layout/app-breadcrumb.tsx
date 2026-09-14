import { Link, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
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
  '/profile': 'Profile',
  '/activity': 'Activity',
};

function titleFor(pathname: string, pluginNames: Map<string, string>): string {
  if (pathname in ROUTE_TITLES) return ROUTE_TITLES[pathname];
  // A plugin page's title is the plugin's own name, which is only known at
  // runtime — so it is looked up rather than listed above.
  const pluginId = pathname.startsWith('/plugins/') ? pathname.slice('/plugins/'.length) : null;
  if (pluginId) return pluginNames.get(pluginId) ?? pluginId;
  const match = Object.entries(ROUTE_TITLES).find(
    ([path]) => path !== '/' && pathname.startsWith(path),
  );
  return match ? match[1] : '';
}

export function AppBreadcrumb() {
  const agent = useAgent();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: plugins } = useQuery({
    queryKey: ['prism-plugins'],
    queryFn: () => runtimeApi.listPrismPlugins(),
  });
  const title = titleFor(
    pathname,
    new Map((plugins ?? []).map((p) => [p.id, p.name])),
  );
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
