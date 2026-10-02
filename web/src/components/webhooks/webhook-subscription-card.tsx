import { KeyRound, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { CopyButton } from '@/components/shared/copy-button';
import { WebhookAuthBadge } from './webhook-auth-badge';
import type { WebhookSubscription } from '@lensapp/prism-client';

interface WebhookSubscriptionCardProps {
  subscription: WebhookSubscription;
  endpoint: string | null;
  deliveryLabel: string;
  isUpdating: boolean;
  onToggle: (active: boolean) => void;
  onAuthenticate: () => void;
  onDelete: () => void;
}

export function WebhookSubscriptionCard({
  subscription,
  endpoint,
  deliveryLabel,
  isUpdating,
  onToggle,
  onAuthenticate,
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
          {deliveryLabel}{subscription.deliverOnly ? ' · Direct delivery' : ' · Agent response'}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/40 p-2">
        <code className="min-w-0 flex-1 break-all bg-transparent p-0 font-mono text-xs">{endpoint ?? `/agents/webhooks/${subscription.name}`}</code>
        {endpoint && <CopyButton text={endpoint} label="Copy endpoint URL" className="size-9 shrink-0" />}
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" className="h-9" onClick={onAuthenticate} aria-label={`Authentication for ${subscription.name}`}>
          <KeyRound />
          Authentication
        </Button>
        <Button variant="ghost" size="icon-lg" onClick={onDelete} aria-label={`Delete ${subscription.name}`} className="text-muted-foreground hover:text-destructive">
          <Trash2 />
        </Button>
      </div>
    </Card>
  );
}
