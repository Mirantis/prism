import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { CopyButton } from '@/components/shared/copy-button';
import { WebhookAuthBadge } from './webhook-auth-badge';
import type { WebhookSubscription } from '@/types';

interface WebhookSubscriptionCardProps {
  subscription: WebhookSubscription;
  endpoint: string | null;
  deliveryLabel: string;
  isUpdating: boolean;
  onToggle: (active: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** What a delivery from this subscription posts. */
function deliveryMode(subscription: WebhookSubscription): string {
  if (subscription.deliverOnly) return 'Direct delivery';
  if (subscription.deliverTo === 'none') return 'Agent runs';
  return 'Agent response';
}

export function WebhookSubscriptionCard({
  subscription,
  endpoint,
  deliveryLabel,
  isUpdating,
  onToggle,
  onEdit,
  onDelete,
}: WebhookSubscriptionCardProps) {
  return (
    <Card className="gap-3 p-4" aria-label={`Subscription ${subscription.name}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="break-all font-medium text-strong">{subscription.name}</h3>
          {subscription.description && (
            <p className="break-words text-sm text-muted-foreground">{subscription.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">{subscription.isActive ? 'Active' : 'Paused'}</span>
          <Switch
            checked={subscription.isActive}
            onCheckedChange={onToggle}
            disabled={isUpdating}
            aria-label={`Toggle ${subscription.name}`}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <WebhookAuthBadge authType={subscription.authType} />
        <span className="text-xs text-muted-foreground">
          {deliveryLabel} · {deliveryMode(subscription)}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/40 p-2">
        <code className="min-w-0 flex-1 break-all bg-transparent p-0 font-mono text-xs">{endpoint ?? `/agents/webhooks/${subscription.name}`}</code>
        {endpoint && <CopyButton text={endpoint} label="Copy endpoint URL" className="size-9 shrink-0" />}
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" className="h-9" onClick={onEdit} aria-label={`Edit ${subscription.name}`}>
          <Pencil />
          Edit
        </Button>
        <Button variant="ghost" size="icon-lg" onClick={onDelete} aria-label={`Delete ${subscription.name}`} className="text-muted-foreground hover:text-destructive">
          <Trash2 />
        </Button>
      </div>
    </Card>
  );
}
