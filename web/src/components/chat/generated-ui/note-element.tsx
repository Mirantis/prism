import { Info } from 'lucide-react';

export function NoteElement({ text }: { text: string }) {
  return (
    <div role="note" className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2 text-muted-foreground">
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 break-words">{text}</p>
    </div>
  );
}
