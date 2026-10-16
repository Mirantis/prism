import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { removeComputer, renameComputer } from '@/api/computer';
import { CreateModal } from '@/components/shared/create-modal';
import { DeleteConfirm } from '@/components/shared/delete-confirm';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { COMPUTERS_QUERY_KEY } from '@/hooks/use-computers';
import type { ComputerSummary } from '@/types';
import { ComputerListItem } from './computer-list-item';

/** The agent's computers, with the selected one marked; a remote one can be renamed or removed. */
export function ComputerList({
  computers,
  selectedId,
  onSelect,
}: {
  computers: ComputerSummary[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState<ComputerSummary | null>(null);
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<ComputerSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: COMPUTERS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['computer'] }),
    ]);

  const rename = async () => {
    if (!renaming) return;
    setBusy(true);
    try {
      await renameComputer(renaming.id, name.trim());
      await refresh();
      setRenaming(null);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      await removeComputer(removing.id);
      setRemoving(null);
      // Only the list is read again: the removed computer's status would answer 404.
      queryClient.setQueryData<ComputerSummary[]>(COMPUTERS_QUERY_KEY, (list) =>
        list?.filter((computer) => computer.id !== removing.id),
      );
      await queryClient.invalidateQueries({ queryKey: COMPUTERS_QUERY_KEY });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Computers" className="space-y-2">
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {computers.map((computer) => (
          <ComputerListItem
            key={computer.id}
            computer={computer}
            selected={computer.id === selectedId}
            onSelect={() => onSelect(computer.id)}
            onRename={() => {
              setName(computer.name);
              setRenaming(computer);
            }}
            onRemove={() => {
              setError(null);
              setRemoving(computer);
            }}
          />
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <CreateModal
        isOpen={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename computer"
        onSubmit={rename}
        isSubmitting={busy}
        submitLabel="Save"
        submitDisabled={!name.trim()}
      >
        <Field>
          <FieldLabel htmlFor="computer-name">Name</FieldLabel>
          <Input
            id="computer-name"
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      </CreateModal>
      <DeleteConfirm
        isOpen={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
        isDeleting={busy}
        entityType="computer"
        entityName={removing?.name ?? ''}
        warning="Prism can no longer use it. Its computer client has to add it again to reconnect."
      />
    </section>
  );
}
