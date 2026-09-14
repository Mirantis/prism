import { Link, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, MessageSquare, MessagesSquare, Clock, Webhook, Bot, Activity } from 'lucide-react';
import { runtimeApi } from '@/api/runtime-client';
import { iconFor } from '@/components/plugin-ui/icon';
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
import { RecentsNav } from './recents-nav';

const NAV_ITEMS = [
  { to: '/' as const, label: 'Overview', icon: LayoutDashboard },
  { to: '/chat' as const, label: 'Chat', icon: MessageSquare },
  { to: '/channels' as const, label: 'Channels', icon: MessagesSquare },
  { to: '/cron' as const, label: 'Scheduled Tasks', icon: Clock },
  { to: '/webhooks' as const, label: 'Webhooks', icon: Webhook },
  { to: '/profile' as const, label: 'Profile', icon: Bot },
  { to: '/activity' as const, label: 'Activity', icon: Activity },
];

export function AppSidebar() {
  const agent = useAgent();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Installed plugins are ordinary pages, listed with the built-in ones. A
  // failure here leaves the built-in navigation intact.
  const { data: plugins } = useQuery({
    queryKey: ['prism-plugins'],
    queryFn: () => runtimeApi.listPrismPlugins(),
  });

  return (
    <Sidebar variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />}>
              <div className="flex aspect-square size-8 items-center justify-center">
                <img src="/prism-logo.svg" alt="Prism Agent" width={28} height={28} />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">Prism Agent</span>
                <span className="truncate text-xs text-muted-foreground">Self-contained runtime</span>
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
            {(plugins ?? []).map((plugin) => {
              const PluginIcon = iconFor(plugin.icon);
              const path = `/plugins/${plugin.id}`;
              return (
                <SidebarMenuItem key={plugin.id}>
                  <SidebarMenuButton
                    isActive={pathname === path}
                    render={
                      <Link to="/plugins/$pluginId" params={{ pluginId: plugin.id }} />
                    }
                  >
                    <PluginIcon className="size-4" />
                    <span>{plugin.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        {/* Conversation threads — only on the Chat page, ChatGPT-style. */}
        {pathname.startsWith('/chat') && <RecentsNav />}
      </SidebarContent>

    </Sidebar>
  );
}
