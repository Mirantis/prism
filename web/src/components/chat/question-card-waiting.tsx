import { CircleHelp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { answeredCount, type QuestionChoice } from '@/lib/question-card';
import type { QuestionCardBlock } from '@/types';
import { QuestionCardQuestion } from './question-card-question';

export type SendState = 'idle' | 'sending' | 'error' | 'refused';

const SEND_FAILURES: Partial<Record<SendState, string>> = {
  error: 'Couldn’t send your answers. Check your connection, then try again.',
  refused: 'Couldn’t send these answers. Reload the page to see the current questions.',
};

/** The card while it waits: every question, and the bar that sends the answers. */
export function QuestionCardWaiting({
  card,
  choices,
  sendState,
  titleId,
  onChoice,
  onSend,
}: {
  card: QuestionCardBlock;
  choices: QuestionChoice[];
  sendState: SendState;
  titleId: string;
  onChoice: (index: number, choice: QuestionChoice) => void;
  onSend: () => void;
}) {
  const total = card.questions.length;
  const several = total > 1;
  const answered = answeredCount(choices);
  const sending = sendState === 'sending';
  const label = several ? 'Send answers' : 'Send answer';
  const failure = SEND_FAILURES[sendState];
  return (
    <>
      <div className="flex items-center gap-2">
        <CircleHelp aria-hidden="true" className="size-[1.125rem] shrink-0 text-warning" />
        <h3 id={titleId} className="text-[0.8125rem] font-medium text-muted-foreground">
          {several ? `${total} questions` : '1 question'}
        </h3>
      </div>
      {card.intro && (
        <p className="mt-2 text-[0.9375rem] leading-6 break-words text-foreground" data-testid="question-card-intro">
          {card.intro}
        </p>
      )}
      <fieldset disabled={sending} aria-labelledby={titleId} className="mt-4 flex min-w-0 flex-col gap-6">
        {card.questions.map((question, index) => (
          <QuestionCardQuestion
            key={`${index}-${question.text}`}
            question={question}
            questionNumber={index + 1}
            showNumber={several}
            otherMaxLength={card.otherMaxLength}
            choice={choices[index]}
            onChange={(choice) => onChoice(index, choice)}
          />
        ))}
      </fieldset>
      {failure && (
        // The design system's reds are below 4.5:1 on the card, so this one is lifted toward the strong text colour.
        <p role="alert" className="mt-4 text-[color-mix(in_srgb,var(--destructive)_70%,var(--strong))]" data-testid="question-card-error">
          {failure}
        </p>
      )}
      <div className="mt-4 flex flex-col-reverse border-t pt-3 @[38rem]:flex-row @[38rem]:items-center @[38rem]:justify-between">
        {several && (
          <p
            aria-live="polite"
            className="mt-2 text-center text-muted-foreground empty:mt-0 @[38rem]:mt-0 @[38rem]:text-left"
            data-testid="question-card-status"
          >
            {answered > 0 && `${answered} of ${total} answered`}
          </p>
        )}
        <Button
          type="button"
          size="lg"
          className="min-h-11 w-full min-w-35 bg-primary-strong outline-hidden hover:bg-primary-strong-hover focus-visible:ring-2 focus-visible:ring-foreground disabled:bg-(--lds-color-surface-selected) disabled:text-control-border disabled:opacity-100 @[38rem]:ml-auto @[38rem]:w-auto"
          disabled={answered === 0 && !sending}
          // Kept enabled while sending, so that it holds focus until the card closes.
          aria-disabled={sending || undefined}
          onClick={sending ? undefined : onSend}
        >
          {sending && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
          {sending ? 'Sending…' : label}
        </Button>
      </div>
    </>
  );
}
