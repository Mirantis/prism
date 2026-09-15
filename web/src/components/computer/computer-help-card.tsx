import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Monitor, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { computerRequest } from '@/api/computer';
import { useComputerStatus } from '@/hooks/use-computer-status';
import type { ComputerHelp } from '@/types';

export function ComputerHelpCard({
  help,
  clientId,
  inComputer,
}: {
  help: ComputerHelp;
  clientId?: string | null;
  inComputer?: boolean;
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
      className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 space-y-3"
      aria-label="Computer help"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Monitor className="size-4 text-amber-500" />
        {current.status === 'waiting'
          ? 'Needs your help'
          : current.status === 'continued'
            ? 'Ready to continue'
            : 'Dismissed'}
      </div>
      <p className="text-sm text-muted-foreground">{help.reason}</p>
      {current.status === 'waiting' && (
        <div className="flex flex-wrap items-center gap-2">
          <a className="text-sm underline underline-offset-4" href={`/computer?help=${help.id}`}>
            {inComputer ? 'Select request' : 'Open Computer'}{' '}
            <ArrowUpRight className="inline size-3" />
          </a>
          <Button size="sm" disabled={busy} onClick={() => void resolve('continue')}>
            Continue
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void resolve('dismiss')}>
            Dismiss
          </Button>
        </div>
      )}
      {help.threadId && inComputer && (
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
