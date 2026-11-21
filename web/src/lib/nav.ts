import {
  Activity,
  Bot,
  CircleDollarSign,
  Clock,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  MonitorPlay,
  Webhook,
} from 'lucide-react';

export interface NavItem {
  to: '/' | '/chat' | '/channels' | '/cron' | '/webhooks' | '/profile' | '/computer' | '/activity' | '/spending';
  label: string;
  icon: typeof Bot;
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
      { to: '/computer', label: 'Computer', icon: MonitorPlay },
      { to: '/activity', label: 'Activity', icon: Activity },
      { to: '/spending', label: 'Spending', icon: CircleDollarSign },
    ],
  },
];

/** The page a path belongs to: `/` exactly, any other page by prefix. */
export function navItemFor(pathname: string): NavItem | undefined {
  return NAV_GROUPS.flatMap((g) => g.items).find((item) =>
    item.to === '/' ? pathname === '/' : pathname.startsWith(item.to),
  );
}
