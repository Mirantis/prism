import { useEffect } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
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
import { NAV_GROUPS, visibleNavItems } from '@/lib/nav';
import { AgentPresence } from './agent-presence';
import { NewChatButton } from './new-chat-button';
import { SearchButton } from './search-button';
import { RecentsNav } from './recents-nav';

export function AppSidebar() {
  const agent = useAgent();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { setOpenMobile } = useSidebar();

  // On a phone the sidebar is a sheet over the page, so picking a page closes it.
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader className="gap-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />} tooltip={agent.name}>
              <div className="relative shrink-0">
                <div className="brand-tile flex aspect-square size-8 items-center justify-center rounded-lg">
                  <img src="/prism-logo.svg" alt="" width={20} height={20} />
                </div>
                {/* Inside the tile's box: the button clips its overflow when the sidebar is icons only. */}
                <AgentPresence className="right-0 bottom-0" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold text-strong">{agent.name}</span>
                <span className="truncate text-xs text-muted-foreground">Prism Agent</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <NewChatButton />
        <SearchButton />
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label} className="py-1">
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {visibleNavItems(group.items, agent.hasComputer).map(({ to, label, icon: Icon }) => {
                const isActive = to === '/' ? pathname === '/' : pathname.startsWith(to);
                return (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton
                      isActive={isActive}
                      tooltip={label}
                      render={<Link to={to} aria-current={isActive ? 'page' : undefined} />}
                      // The page on screen: a tinted row, its icon in the accent, and a short bar
                      // at its left edge.
                      className="relative before:absolute before:top-1/2 before:-left-2 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-primary before:opacity-0 before:transition-opacity data-active:bg-primary/10 data-active:text-strong data-active:before:opacity-100 data-active:[&>svg]:text-primary group-data-[collapsible=icon]:before:hidden"
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
