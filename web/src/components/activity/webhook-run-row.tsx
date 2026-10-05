import { useState } from 'react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { ChevronRight } from 'lucide-react';
import { formatRelativeTime } from '@/lib/format';
import { WebhookRunDetails } from './webhook-run-details';
import type { WebhookRunStatus, WebhookRunSummary } from '@/types';

const STATUS: Record<WebhookRunStatus, { label: string; dot: string; badge: string }> = {
  queued: { label: 'Queued', dot: 'bg-muted-foreground', badge: '' },
  running: { label: 'Running', dot: 'bg-primary animate-pulse', badge: '' },
  completed: { label: 'Completed', dot: 'bg-success', badge: '' },
  delivered: { label: 'Delivered', dot: 'bg-success', badge: '' },
  failed: { label: 'Failed', dot: 'bg-destructive', badge: 'bg-destructive/10 text-destructive' },
  budget_exceeded: {
    label: 'Spending limit reached',
    dot: 'bg-warning',
    badge: 'border-warning/30 bg-warning/8 text-warning',
  },
};

/** One webhook event: its name, event type, result and time, expanding to what it delivered. */
export function WebhookRunRow({ run }: { run: WebhookRunSummary }) {
  const [open, setOpen] = useState(false);
  const status = STATUS[run.status];

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        data-testid="activity-webhook-run"
        data-status={run.status}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${status.dot}`} />
        <span className="shrink-0 font-medium text-foreground">{run.name}</span>
        {run.event !== 'unknown' && (
          <span className="min-w-0 truncate font-mono text-muted-foreground">{run.event}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-[11px] text-muted-foreground">
          <Badge variant="secondary" className={`h-4 px-1.5 text-[10px] font-normal ${status.badge}`}>
            {status.label}
          </Badge>
          <span title={new Date(run.createdAt).toLocaleString()}>{formatRelativeTime(run.createdAt)}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>{open && <WebhookRunDetails run={run} />}</CollapsibleContent>
    </Collapsible>
  );
}
