import { useId, useState } from 'react';
import { ApiError } from '@/api/errors';
import { runtimeApi } from '@/api/runtime-client';
import type { Viewer } from '@/lib/chat-socket/protocol';
import { isGeneratedUi, type Attachment, type GeneratedUiBlock } from '@/types';
import { pressedNote } from './pressed-note';
import { UiElement, type UiScope } from './ui-element';

type Failure = 'error' | 'refused';

const PRESS_FAILURES: Record<Failure, string> = {
  error: 'Couldn’t send your choice. Check your connection, then try again.',
  refused: 'Couldn’t send this choice. Reload the page to see the current buttons.',
};

const REPLY_DELAYED = 'Your choice is saved. The reply is delayed.';

/** What a screen reader hears when this client's press settles, since the pressed button loses focus as it is disabled. */
function pressNotice(ui: GeneratedUiBlock, viewer: Viewer | undefined, pressedHere: boolean, replyPending: boolean): string | null {
  if (replyPending) return REPLY_DELAYED;
  if (!pressedHere || !ui.pressed) return null;
  return pressedNote(ui.pressed, viewer);
}

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
  const [pressedHere, setPressedHere] = useState(false);
  const pressedNoteId = useId();

  const ui = block.pressed ? block : (served ?? block);

  const press = async (elementId: string) => {
    setSending(elementId);
    setFailure(null);
    try {
      const { ui: stored, replyPending: pending } = await runtimeApi.pressGeneratedUiButton(block.id, elementId);
      setReplyPending(Boolean(pending));
      setPressedHere(true);
      setServed(stored);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      const stored = status === 409 ? ((error as ApiError).body as { ui?: unknown } | undefined)?.ui : undefined;
      if (!isGeneratedUi(stored)) {
        setFailure(status === 400 || status === 404 ? 'refused' : 'error');
        return;
      }
      setPressedHere(true);
      setServed(stored);
    } finally {
      setSending(null);
    }
  };

  const notice = pressNotice(ui, viewer, pressedHere, replyPending);
  const scope: UiScope = { ui, attachments, viewer, sending, pressedNoteId, onPress: (id) => void press(id) };
  return (
    <div
      aria-busy={sending !== null}
      // On a phone the block takes the avatar's column too, as a question card does.
      className="@container w-full space-y-3 rounded-xl border border-foreground/10 bg-secondary p-3.5 text-sm shadow-sm max-sm:-ml-10 max-sm:w-[calc(100%+2.5rem)] sm:p-4"
      data-testid="generated-ui"
    >
      {/* Mounted from the start, since a screen reader announces a change to a region it already has. First, so it adds no gap below the last child. */}
      <p role="status" className="sr-only">
        {notice}
      </p>
      <UiElement id={ui.root} scope={scope} />
      {failure && !ui.pressed && (
        // The design system's reds are below 4.5:1 on the card, so this one is lifted toward the strong text colour.
        <p role="alert" className="text-[color-mix(in_srgb,var(--destructive)_70%,var(--strong))]">
          {PRESS_FAILURES[failure]}
        </p>
      )}
      {replyPending && (
        <p aria-hidden="true" className="text-muted-foreground" data-testid="generated-ui-notice">
          {REPLY_DELAYED}
        </p>
      )}
    </div>
  );
}
