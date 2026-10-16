import { useState } from 'react';
import { useComputerStatus } from '@/hooks/use-computer-status';
import { computerAction } from '@/api/computer';
import { Button } from '@/components/ui/button';

/** Shown while a conversation waits for one computer that another invocation holds. */
export function ComputerQueueNotice({ computerId, threadId }: { computerId: string; threadId: string }) {
  const { data } = useComputerStatus(computerId);
  const [error, setError] = useState<string | null>(null);
  if (!data?.waiting.some((item) => item.threadId === threadId)) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
      role="status"
      data-testid="computer-waiting"
    >
      <span>Waiting for the computer</span>
      {data.owner?.threadId && (
        <a className="underline" href={`/chat/${data.owner.threadId}`}>
          Open active conversation
        </a>
      )}
      {data.owner && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void computerAction(computerId, 'stop').catch((err) => setError(String(err)))}
        >
          Stop current task
        </Button>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
