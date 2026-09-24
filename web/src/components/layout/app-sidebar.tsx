import { Link, useRouterState } from '@tanstack/react-router';
import {
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  Clock,
  Webhook,
  MonitorPlay,
  Bot,
  Activity,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useAgent } from '@/lib/agent-context';
import { RecentsNav } from './recents-nav';

const NAV_ITEMS = [
  { to: '/' as const, label: 'Overview', icon: LayoutDashboard },
  { to: '/chat' as const, label: 'Chat', icon: MessageSquare },
  { to: '/channels' as const, label: 'Channels', icon: MessagesSquare },
  { to: '/cron' as const, label: 'Scheduled Tasks', icon: Clock },
  { to: '/webhooks' as const, label: 'Webhooks', icon: Webhook },
  { to: '/profile' as const, label: 'Profile', icon: Bot },
  // Left out where the runtime has no desktop to give the agent; see `hasComputer`.
  { to: '/computer' as const, label: 'Computer', icon: MonitorPlay, needsComputer: true },
  { to: '/activity' as const, label: 'Activity', icon: Activity },
];

export function AppSidebar() {
  const agent = useAgent();
  const { setOpenMobile } = useSidebar();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <Sidebar variant="inset">
      <nav
        aria-label="Workspace navigation"
        className="app-sidebar flex h-full min-h-0 flex-col"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a')) setOpenMobile(false);
        }}
      >
        <SidebarHeader className="px-3 pb-5 pt-4">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" render={<Link to="/" />}>
                <div className="flex aspect-square size-10 items-center justify-center rounded-xl border border-sidebar-border bg-background">
                  <img src="/prism-logo.svg" alt="Prism Agent" width={28} height={28} />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight gap-1">
                  <span className="truncate font-semibold">Prism Agent</span>
                  <span className="truncate text-xs text-muted-foreground">
                    Your agent workspace
                  </span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarMenu>
              {NAV_ITEMS.filter((item) => !item.needsComputer || agent.hasComputer).map(
                ({ to, label, icon: Icon }) => {
                  const isActive = to === '/' ? pathname === '/' : pathname.startsWith(to);
                  return (
                    <SidebarMenuItem key={to}>
                      <SidebarMenuButton
                        className="h-10 px-3"
                        isActive={isActive}
                        render={<Link to={to} aria-current={isActive ? 'page' : undefined} />}
                      >
                        <Icon className="size-4" />
                        <span>{label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                },
              )}
            </SidebarMenu>
          </SidebarGroup>

          {pathname.startsWith('/chat') && <RecentsNav />}
        </SidebarContent>

        <SidebarFooter className="border-t border-sidebar-border p-3">
          <Link
            to="/profile"
            className="flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-sidebar-accent"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-sidebar-border bg-background">
              <Bot className="size-4 text-primary" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{agent.name}</span>
              <span className="block text-xs text-muted-foreground">Agent profile</span>
            </span>
          </Link>
        </SidebarFooter>
      </nav>
    </Sidebar>
  );
}
