import { useEffect } from 'react';
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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { useAgent } from '@/lib/agent-context';
import { NewChatButton } from './new-chat-button';
import { RecentsNav } from './recents-nav';

interface NavItem {
  to: '/' | '/chat' | '/channels' | '/cron' | '/webhooks' | '/profile' | '/computer' | '/activity';
  label: string;
  icon: typeof Bot;
  needsComputer?: boolean;
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Workspace',
    items: [
      { to: '/', label: 'Overview', icon: LayoutDashboard },
      { to: '/chat', label: 'Chat', icon: MessageSquare },
    ],
  },
  {
    label: 'Automation',
    items: [
      { to: '/channels', label: 'Channels', icon: MessagesSquare },
      { to: '/cron', label: 'Scheduled Tasks', icon: Clock },
      { to: '/webhooks', label: 'Webhooks', icon: Webhook },
    ],
  },
  {
    label: 'Agent',
    items: [
      { to: '/profile', label: 'Profile', icon: Bot },
      // Left out where the runtime has no desktop to give the agent; see `hasComputer`.
      { to: '/computer', label: 'Computer', icon: MonitorPlay, needsComputer: true },
      { to: '/activity', label: 'Activity', icon: Activity },
    ],
  },
];

export function AppSidebar() {
  const agent = useAgent();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { setOpenMobile } = useSidebar();

  // On a phone the sidebar is a sheet over the page, so picking a page closes it.
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader className="gap-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />}>
              <div className="brand-tile flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg">
                <img src="/prism-logo.svg" alt="" width={20} height={20} />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold text-strong">{agent.name}</span>
                <span className="truncate text-xs text-muted-foreground">Prism Agent</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <NewChatButton />
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label} className="py-1">
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items
                .filter((item) => !item.needsComputer || agent.hasComputer)
                .map(({ to, label, icon: Icon }) => {
                  const isActive = to === '/' ? pathname === '/' : pathname.startsWith(to);
                  return (
                    <SidebarMenuItem key={to}>
                      <SidebarMenuButton
                        isActive={isActive}
                        tooltip={label}
                        render={<Link to={to} />}
                        className="data-active:bg-primary/10 data-active:text-strong data-active:[&>svg]:text-primary"
                      >
                        <Icon className="size-4" />
                        <span>{label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
            </SidebarMenu>
          </SidebarGroup>
        ))}

        {/* Conversation threads — only on the Chat page. */}
        {pathname.startsWith('/chat') && <RecentsNav />}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
