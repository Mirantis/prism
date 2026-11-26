import type { ReactNode } from 'react';

/** A row of buttons, and who pressed one of them. */
export function ActionsElement({ note, noteId, children }: { note: string | null; noteId: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">{children}</div>
      {note && (
        <p id={noteId} className="text-muted-foreground" data-testid="generated-ui-pressed">
          {note}
        </p>
      )}
    </div>
  );
}
