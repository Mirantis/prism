import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Bot, Clock, MessagesSquare } from 'lucide-react';

const SHORTCUTS = [
  {
    to: '/profile',
    title: 'Shape your agent',
    description: 'Instructions, personality, and memory',
    icon: Bot,
  },
  {
    to: '/cron',
    title: 'Build a routine',
    description: 'Schedules for recurring work',
    icon: Clock,
  },
  {
    to: '/channels',
    title: 'Connect to Slack',
    description: 'Bring your agent into the conversation',
    icon: MessagesSquare,
  },
] as const;

export function WorkspaceShortcuts() {
  return (
    <section
      className="rounded-2xl border border-border bg-card p-5 sm:p-6"
      aria-labelledby="shortcuts-title"
    >
      <h2 id="shortcuts-title" className="text-base font-semibold">
        Make it work for you
      </h2>
      <p className="mt-1 mb-5 text-sm text-muted-foreground">A few ways to get more done.</p>
      <div className="space-y-2">
        {SHORTCUTS.map(({ to, title, description, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="group flex items-start gap-3 rounded-xl p-3 transition-colors hover:bg-accent"
          >
            <Icon className="mt-0.5 size-5 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium">{title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
            </div>
            <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </section>
  );
}
