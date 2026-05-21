import { Link, useRouterState } from '@tanstack/react-router';
import { LayoutDashboard, MessageSquare, MessagesSquare, Clock, Bot } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useAgent } from '@/lib/agent-context';

const NAV_ITEMS = [
  { to: '/' as const, label: 'Overview', icon: LayoutDashboard },
  { to: '/chat' as const, label: 'Chat', icon: MessageSquare },
  { to: '/channels' as const, label: 'Channels', icon: MessagesSquare },
  { to: '/cron' as const, label: 'Scheduled Tasks', icon: Clock },
  { to: '/profile' as const, label: 'Profile', icon: Bot },
];

export function AppSidebar() {
  const agent = useAgent();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <Sidebar variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />}>
              <div className="flex aspect-square size-8 items-center justify-center">
                <img src="/prism-logo.svg" alt="Prism" width={28} height={28} />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">Prism</span>
                <span className="truncate text-xs text-muted-foreground">Agent runtime</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{agent.name}</SidebarGroupLabel>
          <SidebarMenu>
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
              const isActive = to === '/' ? pathname === '/' : pathname.startsWith(to);
              return (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton isActive={isActive} render={<Link to={to} />}>
                    <Icon className="size-4" />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

    </Sidebar>
  );
}
