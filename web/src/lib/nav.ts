import {
  Activity,
  Bot,
  Clock,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  MonitorPlay,
  Webhook,
} from 'lucide-react';

export interface NavItem {
  to: '/' | '/chat' | '/channels' | '/cron' | '/webhooks' | '/profile' | '/computer' | '/activity';
  label: string;
  icon: typeof Bot;
  needsComputer?: boolean;
}

/** The app's pages, grouped as the sidebar shows them. */
export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
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

/** The pages this runtime offers. */
export function visibleNavItems(items: NavItem[], hasComputer: boolean | undefined): NavItem[] {
  return items.filter((item) => !item.needsComputer || hasComputer);
}

/** The page a path belongs to: `/` exactly, any other page by prefix. */
export function navItemFor(pathname: string): NavItem | undefined {
  return NAV_GROUPS.flatMap((g) => g.items).find((item) =>
    item.to === '/' ? pathname === '/' : pathname.startsWith(item.to),
  );
}
