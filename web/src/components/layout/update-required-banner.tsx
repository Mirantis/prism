import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChatSocket } from '@/hooks/use-chat-socket';

/**
 * Shown when the runtime no longer speaks this page's chat protocol. The page stops
 * reconnecting then, because only a reload brings the matching version.
 */
export function UpdateRequiredBanner() {
  const { status } = useChatSocket();
  if (status !== 'update-required') return null;

  return (
    <div
      role="alert"
      data-testid="update-required-banner"
      className="mx-4 mb-2 flex items-center gap-2 rounded-xl bg-card px-3 py-2 text-sm ring-1 ring-foreground/10 md:mx-6"
    >
      <RefreshCw className="size-4" />
      <span className="flex-1">Prism Agent has been updated. Reload this page to keep chatting.</span>
      <Button size="sm" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}
