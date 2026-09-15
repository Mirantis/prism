import { createFileRoute } from '@tanstack/react-router';
import { useAgent } from '@/lib/agent-context';
import { ComputerView } from '@/components/computer/computer-view';

export const Route = createFileRoute('/computer')({
  validateSearch: (search: Record<string, unknown>) => ({ help: typeof search.help === 'string' ? search.help : undefined }),
  component: ComputerPage,
});

function ComputerPage() {
  const agent = useAgent();
  const { help } = Route.useSearch();
  if (agent.hasComputer === false) return <div className="mx-auto max-w-md space-y-2 py-16 text-center">
    <h1 className="text-sm font-medium">This runtime has no computer</h1>
    <p className="text-sm text-muted-foreground">Run the published container image to give Prism a desktop.</p>
  </div>;
  return <ComputerView helpId={help} />;
}
