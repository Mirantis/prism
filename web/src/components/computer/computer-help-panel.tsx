import type { ComputerHelp } from '@/types';
import { ComputerHelpCard } from './computer-help-card';

export function ComputerHelpPanel({
  requests,
  selected,
  clientId,
  disabled,
  canSelect,
  onSelect,
}: {
  requests: ComputerHelp[];
  selected: ComputerHelp;
  clientId: string | null;
  disabled: boolean;
  canSelect: boolean;
  onSelect: (id: string) => void;
}) {
  const others = requests.filter((request) => request.id !== selected.id);
  return (
    <aside
      aria-label="Computer assistance"
      className="order-1 min-w-0 space-y-4 xl:sticky xl:top-0 xl:order-2 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto"
    >
      <ComputerHelpCard
        key={selected.id}
        help={selected}
        clientId={clientId}
        inComputer
        disabled={disabled}
      />
      {others.length > 0 && (
        <section className="space-y-2 rounded-xl border p-4">
          <h2 className="text-xs font-medium text-muted-foreground">
            Other requests · {others.length}
          </h2>
          {others.map((request) => (
            <button
              key={request.id}
              type="button"
              disabled={!canSelect}
              onClick={() => onSelect(request.id)}
              className="block w-full rounded-lg p-2 text-left text-sm leading-relaxed hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {request.reason}
            </button>
          ))}
        </section>
      )}
    </aside>
  );
}
