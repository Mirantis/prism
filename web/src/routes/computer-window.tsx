import { createFileRoute } from '@tanstack/react-router';
import { ComputerView } from '@/components/computer/computer-view';

export const Route = createFileRoute('/computer-window')({
  validateSearch: (search: Record<string, unknown>) => ({
    help: typeof search.help === 'string' ? search.help : undefined,
  }),
  component: ComputerWindowPage,
});

function ComputerWindowPage() {
  const { help } = Route.useSearch();
  return <ComputerView helpId={help} />;
}
