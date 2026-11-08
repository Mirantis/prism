import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/errors';
import { runtimeApi } from '@/api/runtime-client';
import { answeredCount, emptyChoice, toAnswers, type QuestionChoice } from '@/lib/question-card';
import type { Viewer } from '@/lib/chat-socket/protocol';
import { isQuestionCard, type QuestionCardBlock } from '@/types';
import { QuestionCardClosed } from './question-card-closed';
import { QuestionCardWaiting, type SendState } from './question-card-waiting';

/** The agent's questions in the chat. Choices live here until they are sent, so a reload drops them. */
export function QuestionCard({ block, viewer }: { block: QuestionCardBlock; viewer: Viewer | undefined }) {
  // The answer route's copy, for a client whose socket missed the change. A closed card never changes again.
  const [served, setServed] = useState<QuestionCardBlock | null>(null);
  const [choices, setChoices] = useState<QuestionChoice[]>(() => block.questions.map(emptyChoice));
  const [sendState, setSendState] = useState<SendState>('idle');
  const [sent, setSent] = useState(false);
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusTitle = useRef(false);
  // Removing a focused control leaves focus on the body with no related target, so this stays true.
  const focusInside = useRef(false);

  const card = served ?? block;
  const waiting = card.status === 'waiting';

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
      const { card: stored } = await runtimeApi.answerQuestionCard(block.id, toAnswers(choices));
      focusTitle.current = true;
      setSent(true);
      setServed(stored);
      setSendState('idle');
    } catch (error) {
      const stored = error instanceof ApiError && error.status === 409 ? (error.body as { card?: unknown } | undefined)?.card : undefined;
      if (!isQuestionCard(stored)) {
        setSendState('error');
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
          choseUnsent={!sent && answeredCount(choices) > 0}
          titleId={titleId}
          titleRef={titleRef}
        />
      )}
    </section>
  );
}
