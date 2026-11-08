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
      <div className="flex items-start gap-3">
        <CircleHelp aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
        <div className="min-w-0">
          <h3 id={titleId} className="font-semibold text-strong">
            {several ? `${total} questions` : '1 question'}
          </h3>
          {card.intro && (
            <p className="mt-0.5 break-words text-muted-foreground" data-testid="question-card-intro">
              {card.intro}
            </p>
          )}
          <p className="mt-0.5 text-muted-foreground">
            {several ? 'Choose your answers, then send them. You can skip any question.' : 'Choose an answer, then send it.'}
          </p>
        </div>
      </div>
      <fieldset disabled={sending} aria-labelledby={titleId} className="mt-4 flex min-w-0 flex-col gap-4">
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
        <p role="alert" className="mt-4 text-destructive" data-testid="question-card-error">
          {failure}
        </p>
      )}
      <div className="mt-4 flex flex-col gap-3 border-t pt-3 @[38rem]:flex-row @[38rem]:items-center @[38rem]:justify-between">
        {several && (
          <p aria-live="polite" className="text-muted-foreground" data-testid="question-card-status">
            {answered} of {total} answered
          </p>
        )}
        <Button
          type="button"
          size="lg"
          className="w-full @[38rem]:ml-auto @[38rem]:w-auto"
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
