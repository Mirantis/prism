import { useState } from 'react';
import { Info } from 'lucide-react';

/** A quiet line for the calls a total leaves out, which opens to say why a call has no price. */
export function SpendingUnpricedNote({ unpricedCalls }: { unpricedCalls: number }) {
  const [open, setOpen] = useState(false);
  if (unpricedCalls === 0) return null;

  return (
    <div className="border-t border-foreground/8 pt-3 text-xs text-muted-foreground" data-testid="spending-unpriced-note">
      <button type="button" className="flex items-center gap-1.5 text-left hover:text-foreground" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Info aria-hidden="true" className="size-3.5 shrink-0" />
        {unpricedCalls} model call{unpricedCalls === 1 ? '' : 's'} in this range {unpricedCalls === 1 ? 'has' : 'have'} no price,
        so these totals are a lower bound.
      </button>
      {open && (
        <p className="mt-2 pl-5">
          A call has no price when its model is a name only your setup knows, such as a LiteLLM alias or an Azure
          deployment name, when it is a transcription billed by the minute, or when the model is newer than the price
          list. Earlier calls are priced as soon as a price for their model arrives.
        </p>
      )}
    </div>
  );
}
