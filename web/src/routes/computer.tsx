import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ComputerList } from '@/components/computer/computer-list';
import { ComputerView } from '@/components/computer/computer-view';
import { useComputers } from '@/hooks/use-computers';
import { useComputerStatuses } from '@/hooks/use-computer-status';
import { LOCAL_COMPUTER_ID } from '@/types';

export const Route = createFileRoute('/computer')({
  validateSearch: (search: Record<string, unknown>) => ({
    help: typeof search.help === 'string' ? search.help : undefined,
    computer: typeof search.computer === 'string' ? search.computer : undefined,
  }),
  component: ComputerPage,
});

function ComputerPage() {
  const { help, computer } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: computers } = useComputers();
  const statuses = useComputerStatuses(computers?.map((item) => item.id) ?? []);
  if (!computers) return null;
  if (computers.length === 0) {
    return (
      <div className="mx-auto max-w-md space-y-2 py-16 text-center">
        <h1 className="text-sm font-medium">No computers yet</h1>
        <p className="text-sm text-muted-foreground">
          A computer appears here when its computer client adds it. Run the published container
          image to give Prism a desktop of its own.
        </p>
      </div>
    );
  }

  // A link to a help request names the request, which knows its computer.
  const helpIndex = help ? statuses.findIndex((status) => status?.help?.some((item) => item.id === help)) : -1;
  const wantedId = computer ?? (helpIndex >= 0 ? computers[helpIndex].id : undefined);
  const selected =
    computers.find((item) => item.id === wantedId) ??
    computers.find((item) => item.id === LOCAL_COMPUTER_ID) ??
    computers[0];

  return (
    <div className="space-y-4">
      <ComputerList
        computers={computers}
        selectedId={selected.id}
        onSelect={(id) => void navigate({ search: { computer: id, help: undefined } })}
      />
      <ComputerView key={selected.id} computer={selected} helpId={help} />
    </div>
  );
}
