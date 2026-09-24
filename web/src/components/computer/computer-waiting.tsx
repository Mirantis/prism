import { useState } from 'react';
import { useAgent } from '@/lib/agent-context';
import { useComputerStatus } from '@/hooks/use-computer-status';
import { computerRequest } from '@/api/computer';
import { Button } from '@/components/ui/button';

export function ComputerWaiting({ threadId }: { threadId?: string }) {
  const agent = useAgent();
  const { data } = useComputerStatus(agent.hasComputer === true);
  const [error, setError] = useState<string | null>(null);
  if (!threadId || !data?.waiting.some((item) => item.threadId === threadId)) return null;
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
          onClick={() => void computerRequest('/stop', {}).catch((err) => setError(String(err)))}
        >
          Stop current task
        </Button>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
