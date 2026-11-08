import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/errors';
import { runtimeApi } from '@/api/runtime-client';
import { answeredCount, emptyChoice, toAnswers, type QuestionChoice } from '@/lib/question-card';
import type { Viewer } from '@/lib/chat-socket/protocol';
import { isQuestionCard, type QuestionCardBlock } from '@/types';
import { QuestionCardClosed } from './question-card-closed';
import { QuestionCardWaiting, type SendState } from './question-card-waiting';

const REPLY_PENDING = 'Your answers are saved. The agent will reply after its next restart.';

function answeredFirstNotice(card: QuestionCardBlock, viewer: Viewer | undefined, choseUnsent: boolean): string | null {
  if (card.status !== 'answered' || !choseUnsent || !card.answeredBy || card.answeredBy.id === viewer?.id) return null;
  return `${card.answeredBy.name} answered first. Your choices weren’t sent.`;
}

/** The agent's questions in the chat. Choices live here until they are sent, so a reload drops them. */
export function QuestionCard({ block, viewer }: { block: QuestionCardBlock; viewer: Viewer | undefined }) {
  // The answer route's copy, for a client whose socket missed the change. A closed card never changes again.
  const [served, setServed] = useState<QuestionCardBlock | null>(null);
  const [choices, setChoices] = useState<QuestionChoice[]>(() => block.questions.map(emptyChoice));
  const [sendState, setSendState] = useState<SendState>('idle');
  const [sent, setSent] = useState(false);
  const [replyPending, setReplyPending] = useState(false);
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusTitle = useRef(false);
  // Removing a focused control leaves focus on the body with no related target, so this stays true.
  const focusInside = useRef(false);

  const card = served ?? block;
  const waiting = card.status === 'waiting';
  const notice = replyPending ? REPLY_PENDING : answeredFirstNotice(card, viewer, !sent && answeredCount(choices) > 0);

  useLayoutEffect(() => {
    if (card.status === 'waiting') return;
    if (focusTitle.current || (focusInside.current && document.activeElement === document.body)) {
      titleRef.current?.focus();
    }
    focusTitle.current = false;
  }, [card.status]);

  const send = async () => {
    setSendState('sending');
    try {
      const { card: stored, replyPending: pending } = await runtimeApi.answerQuestionCard(block.id, toAnswers(choices));
      focusTitle.current = true;
      setSent(true);
      setReplyPending(Boolean(pending));
      setServed(stored);
      setSendState('idle');
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      const stored = status === 409 ? ((error as ApiError).body as { card?: unknown } | undefined)?.card : undefined;
      if (!isQuestionCard(stored)) {
        setSendState(status === 400 || status === 404 ? 'refused' : 'error');
        return;
      }
      focusTitle.current = true;
      setServed(stored);
      setSendState('idle');
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      aria-busy={sendState === 'sending'}
      className="@container w-full max-w-2xl rounded-xl border bg-card p-4 text-sm shadow-sm"
      data-testid="question-card"
      data-status={card.status}
      onFocus={() => {
        focusInside.current = true;
      }}
      onBlur={(event) => {
        if (event.relatedTarget) focusInside.current = event.currentTarget.contains(event.relatedTarget);
      }}
    >
      {waiting ? (
        <QuestionCardWaiting
          card={card}
          choices={choices}
          sendState={sendState}
          titleId={titleId}
          onChoice={(index, choice) => setChoices((current) => current.map((item, at) => (at === index ? choice : item)))}
          onSend={() => void send()}
        />
      ) : (
        <QuestionCardClosed
          card={card}
          viewer={viewer}
          notice={notice}
          titleId={titleId}
          titleRef={titleRef}
        />
      )}
      {/* Mounted from the start, since a screen reader announces a change to a region it already has. */}
      <p role="status" className="sr-only">
        {notice}
      </p>
    </section>
  );
}
