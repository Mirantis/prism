import { useId, useState } from 'react';
import { ApiError } from '@/api/errors';
import { runtimeApi } from '@/api/runtime-client';
import type { Viewer } from '@/lib/chat-socket/protocol';
import { isGeneratedUi, type Attachment, type GeneratedUiBlock } from '@/types';
import { UiElement, type UiScope } from './ui-element';

type Failure = 'error' | 'refused';

const PRESS_FAILURES: Record<Failure, string> = {
  error: 'Couldn’t send your choice. Check your connection, then try again.',
  refused: 'Couldn’t send this choice. Reload the page to see the current buttons.',
};

const REPLY_DELAYED = 'Your choice is saved. The reply is delayed.';

/** The components an agent's message shows: a table, a chart, buttons and the like. */
export function GeneratedUi({
  block,
  viewer,
  attachments,
}: {
  block: GeneratedUiBlock;
  viewer: Viewer | undefined;
  attachments: Attachment[] | null | undefined;
}) {
  // The press route's copy, for a client whose socket missed the change. A pressed block never changes again.
  const [served, setServed] = useState<GeneratedUiBlock | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [replyPending, setReplyPending] = useState(false);
  const pressedNoteId = useId();

  const ui = block.pressed ? block : (served ?? block);

  const press = async (elementId: string) => {
    setSending(elementId);
    setFailure(null);
    try {
      const { ui: stored, replyPending: pending } = await runtimeApi.pressGeneratedUiButton(block.id, elementId);
      setReplyPending(Boolean(pending));
      setServed(stored);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      const stored = status === 409 ? ((error as ApiError).body as { ui?: unknown } | undefined)?.ui : undefined;
      if (isGeneratedUi(stored)) setServed(stored);
      else setFailure(status === 400 || status === 404 ? 'refused' : 'error');
    } finally {
      setSending(null);
    }
  };

  const scope: UiScope = { ui, attachments, viewer, sending, pressedNoteId, onPress: (id) => void press(id) };
  return (
    <div
      aria-busy={sending !== null}
      // On a phone the block takes the avatar's column too, as a question card does.
      className="@container w-full space-y-3 rounded-xl border border-foreground/10 bg-secondary p-3.5 text-sm shadow-sm max-sm:-ml-10 max-sm:w-[calc(100%+2.5rem)] sm:p-4"
      data-testid="generated-ui"
    >
      <UiElement id={ui.root} scope={scope} />
      {failure && !ui.pressed && (
        // The design system's reds are below 4.5:1 on the card, so this one is lifted toward the strong text colour.
        <p role="alert" className="text-[color-mix(in_srgb,var(--destructive)_70%,var(--strong))]">
          {PRESS_FAILURES[failure]}
        </p>
      )}
      {replyPending && <p className="text-muted-foreground">{REPLY_DELAYED}</p>}
    </div>
  );
}
