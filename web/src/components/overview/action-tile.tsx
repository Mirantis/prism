import { Link } from '@tanstack/react-router';
import { ArrowUpRight, type LucideIcon } from 'lucide-react';

export function ActionTile({
  icon: Icon,
  title,
  description,
  to,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  to: '/chat' | '/channels' | '/cron' | '/profile';
}) {
  return (
    <Link to={to} className="action-tile group">
      <div className="flex items-start justify-between gap-4">
        <span className="flex size-10 items-center justify-center rounded-xl border border-border bg-background">
          <Icon className="size-5 text-primary" />
        </span>
        <ArrowUpRight className="size-4 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
      </div>
      <div className="mt-5 space-y-1.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </Link>
  );
}
