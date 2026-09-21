import { createFileRoute } from '@tanstack/react-router';
import { useAgent } from '@/lib/agent-context';
import { ComputerView } from '@/components/computer/computer-view';

import { useComputerWindow } from '@/components/computer/computer-window-provider';
import { Button } from '@/components/ui/button';

export const Route = createFileRoute('/computer')({
  validateSearch: (search: Record<string, unknown>) => ({
    help: typeof search.help === 'string' ? search.help : undefined,
  }),
  component: ComputerPage,
});

function ComputerPage() {
  const agent = useAgent();
  const computerWindow = useComputerWindow();
  const { help } = Route.useSearch();
  if (agent.hasComputer === false)
    return (
      <div className="mx-auto max-w-md space-y-2 py-16 text-center">
        <h1 className="text-sm font-medium">This runtime has no computer</h1>
        <p className="text-sm text-muted-foreground">
          Run the published container image to give Prism a desktop.
        </p>
      </div>
    );
  if (computerWindow.detached)
    return (
      <section
        aria-label="Computer detached"
        className="mx-auto flex max-w-md flex-col gap-3 rounded-xl border bg-card p-4"
      >
        <p className="text-sm">Agent Computer is open in another window.</p>
        <div className="flex gap-2">
          <Button onClick={computerWindow.focus}>Focus window</Button>
          <Button variant="outline" onClick={computerWindow.restore}>
            Restore
          </Button>
        </div>
      </section>
    );
  return <ComputerView helpId={help} />;
}
