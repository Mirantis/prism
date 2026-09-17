import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { computerRequest } from '@/api/computer';
import { useComputerStatus } from '@/hooks/use-computer-status';
import type { ComputerHelp } from '@/types';

export function ComputerHelpCard({
  help,
  clientId,
  showConversationLink = true,
  showHeader = true,
  disabled = false,
}: {
  help: ComputerHelp;
  clientId?: string | null;
  showConversationLink?: boolean;
  showHeader?: boolean;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const { data } = useComputerStatus();
  const current = data?.help?.find((item) => item.id === help.id) ?? help;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (action: 'continue' | 'dismiss') => {
    setBusy(true);
    setError(null);
    try {
      await computerRequest(`/help/${help.id}`, { action, ...(clientId ? { clientId } : {}) });
      await queryClient.invalidateQueries({ queryKey: ['computer'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm"
      aria-label="Computer help"
    >
      {showHeader && (
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
            <Monitor className="size-4" />
          </span>
          {current.status === 'waiting'
            ? 'Needs your help'
            : current.status === 'continued'
              ? 'Ready to continue'
              : 'Dismissed'}
        </div>
      )}
      <p className="break-words text-sm leading-relaxed text-foreground/85">
        {help.reason}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Click the screen to complete this step. Press Esc when you’re done, or choose “I’m done”.
        Prism is stopped while you work here and cannot see the screen. Submit a sign-in before
        you finish: anything left in a password field is cleared.
      </p>
      {current.status === 'waiting' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            className="flex-1"
            disabled={busy || disabled}
            onClick={() => void resolve('continue')}
          >
            I’m done
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || disabled}
            onClick={() => void resolve('dismiss')}
          >
            Dismiss
          </Button>
        </div>
      )}
      {help.threadId && showConversationLink && (
        <a
          className="block text-xs text-muted-foreground underline underline-offset-4"
          href={`/chat/${help.threadId}`}
        >
          Open conversation
        </a>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
