import { KeyRound, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { WebhookAuthType } from '@/types';

export function WebhookAuthBadge({ authType }: { authType: WebhookAuthType }) {
  return (
    <Badge
      variant="outline"
      className={authType === 'none' ? 'border-warning/30 bg-warning/8 text-warning' : undefined}
    >
      {authType === 'none' ? <ShieldAlert /> : <KeyRound />}
      {authType === 'none' ? 'Unverified' : authType === 'hmac' ? 'HMAC signature' : 'Shared token'}
    </Badge>
  );
}
