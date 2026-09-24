import { Link, type LinkProps } from '@tanstack/react-router';
import { ArrowRight, Bot, Clock, MessagesSquare, Webhook } from 'lucide-react';
import { IconTile } from '@/components/shared/icon-tile';
import { SectionHeader } from '@/components/layout/section-header';
import type { Tone } from '@/lib/tones';

const ACTIONS: {
  to: LinkProps['to'];
  icon: typeof Bot;
  tone: Tone;
  title: string;
  description: string;
}[] = [
  {
    to: '/profile',
    icon: Bot,
    tone: 'primary',
    title: 'Shape its personality',
    description: 'Edit identity, heartbeat, memory and vision in plain markdown.',
  },
  {
    to: '/channels',
    icon: MessagesSquare,
    tone: 'teal',
    title: 'Link it to Slack',
    description: 'DM your agent or have it watch a channel.',
  },
  {
    to: '/cron',
    icon: Clock,
    tone: 'warning',
    title: 'Schedule recurring tasks',
    description: 'Run checks and reports on your schedule.',
  },
  {
    to: '/webhooks',
    icon: Webhook,
    tone: 'success',
    title: 'Trigger it from other systems',
    description: 'Give an alerting or CI system its own endpoint.',
  },
];

/** Where to go next to make the agent more useful. */
export function QuickActions() {
  return (
    <section className="space-y-3">
      <SectionHeader title="Get more from your agent" />
      <div className="grid gap-3">
        {ACTIONS.map((action) => (
          <Link
            key={action.title}
            to={action.to}
            className="group/action flex min-w-0 items-center gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10 transition-all hover:bg-card/80 hover:ring-foreground/20"
          >
            <IconTile icon={action.icon} tone={action.tone} size="md" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="text-sm font-medium text-strong">{action.title}</div>
              <div className="truncate text-xs text-muted-foreground">{action.description}</div>
            </div>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover/action:translate-x-0.5 group-hover/action:text-strong" />
          </Link>
        ))}
      </div>
    </section>
  );
}
