import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, CircleHelp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { answeredCount, isAnswered, toggleOption, type QuestionChoice } from '@/lib/question-card';
import { cn } from '@/lib/utils';
import type { QuestionCardBlock } from '@/types';
import { QuestionCardQuestion } from './question-card-question';

export type SendState = 'idle' | 'sending' | 'error' | 'refused';

const SEND_FAILURES: Partial<Record<SendState, string>> = {
  error: 'Couldn’t send your answers. Check your connection, then try again.',
  refused: 'Couldn’t send these answers. Reload the page to see the current questions.',
};

/** A number key chooses an option, except while the person types, holds a modifier or holds the key down. */
function optionKey(event: KeyboardEvent, options: number): number | null {
  // A held key would answer the next questions as well, since focus moves to each one in turn.
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const target = event.target as HTMLElement;
  if (target.isContentEditable || ['TEXTAREA', 'INPUT', 'SELECT'].includes(target.tagName)) {
    // The option inputs themselves take the keys.
    if (!(target instanceof HTMLInputElement && (target.type === 'radio' || target.type === 'checkbox'))) return null;
  }
  const number = Number(event.key);
  return Number.isInteger(number) && number >= 1 && number <= options ? number - 1 : null;
}

/**
 * The card while it waits: one question at a time. Choosing an option of a single-select
 * question moves to the next question, and the last question holds the button that sends
 * every answer.
 */
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
  const [step, setStep] = useState(0);
  const questionText = useRef<HTMLParagraphElement>(null);
  const focusQuestion = useRef(false);
  const total = card.questions.length;
  const several = total > 1;
  const last = step === total - 1;
  const question = card.questions[step];
  const answered = answeredCount(choices);
  const currentAnswered = isAnswered(choices[step]);
  const sending = sendState === 'sending';
  const failure = SEND_FAILURES[sendState];

  // A step change moves focus to the new question's text.
  useLayoutEffect(() => {
    if (!focusQuestion.current) return;
    focusQuestion.current = false;
    questionText.current?.focus();
  }, [step]);

  const goTo = (next: number) => {
    if (sending || next < 0 || next >= total || next === step) return;
    focusQuestion.current = true;
    setStep(next);
  };
  const advance = () => {
    if (!last) goTo(step + 1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (sending) return;
    const option = optionKey(event, question.options.length);
    if (option === null) return;
    event.preventDefault();
    onChoice(step, toggleOption(choices[step], option, question.multiSelect));
    if (!question.multiSelect && !last) {
      advance();
      return;
    }
    // The focused control can leave with the change, as Skip and Clear do, so focus goes to the option.
    event.currentTarget.querySelectorAll<HTMLInputElement>('[data-testid="question-card-option"] input')[option]?.focus();
  };

  return (
    <div onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2">
        <CircleHelp aria-hidden="true" className="size-[1.125rem] shrink-0 text-warning" />
        <h3 id={titleId} className="flex min-w-0 flex-1 items-baseline justify-between gap-2 text-[0.8125rem] font-medium text-muted-foreground">
          <span>Question</span>
          {/* A flex container drops this space from the layout, and the accessible name keeps it. */}
          {several && ' '}
          {several && (
            <span className="tabular-nums" data-testid="question-card-step">
              {step + 1} of {total}
            </span>
          )}
        </h3>
      </div>
      {several && (
        <div className="mt-1 flex gap-1">
          {card.questions.map((item, index) => {
            const done = isAnswered(choices[index]);
            return (
              <button
                key={`${index}-${item.text}`}
                type="button"
                disabled={sending}
                aria-current={index === step ? 'step' : undefined}
                aria-label={`Question ${index + 1}${done ? ', answered' : ''}`}
                className="group/step flex h-6 flex-1 cursor-pointer items-center rounded-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                onClick={() => goTo(index)}
              >
                <span
                  className={cn(
                    'h-1 w-full rounded-full transition-colors',
                    done && (index === step ? 'bg-primary' : 'bg-primary/50'),
                    !done && (index === step ? 'bg-foreground/45' : 'bg-foreground/15 group-hover/step:bg-foreground/25'),
                  )}
                />
              </button>
            );
          })}
        </div>
      )}
      {card.intro && (
        <p className="mt-2 text-[0.9375rem] leading-6 break-words text-foreground" data-testid="question-card-intro">
          {card.intro}
        </p>
      )}
      <fieldset disabled={sending} aria-labelledby={titleId} className="mt-3 min-w-0">
        <QuestionCardQuestion
          key={step}
          question={question}
          questionNumber={step + 1}
          otherMaxLength={card.otherMaxLength}
          choice={choices[step]}
          textRef={questionText}
          onChange={(choice) => onChoice(step, choice)}
          onPicked={advance}
          onEnter={() => {
            if (currentAnswered) advance();
          }}
        />
      </fieldset>
      {failure && (
        // The design system's reds are below 4.5:1 on the card, so this one is lifted toward the strong text colour.
        <p role="alert" className="mt-3 text-[color-mix(in_srgb,var(--destructive)_70%,var(--strong))]" data-testid="question-card-error">
          {failure}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        {step > 0 && (
          <Button
            type="button"
            variant="ghost"
            className="-ml-2 min-h-11 px-2 text-muted-foreground outline-hidden hover:text-strong focus-visible:ring-2 focus-visible:ring-foreground"
            disabled={sending}
            onClick={() => goTo(step - 1)}
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
            Back
          </Button>
        )}
        {/* Mounted on every step, since a screen reader announces a change to a region it already has. */}
        {several && (
          <p aria-live="polite" className="text-muted-foreground" data-testid="question-card-status">
            {last && `${answered} of ${total} answered`}
          </p>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!last && !currentAnswered && (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 px-3 text-muted-foreground outline-hidden hover:text-strong focus-visible:ring-2 focus-visible:ring-foreground"
              disabled={sending}
              onClick={advance}
            >
              Skip
            </Button>
          )}
          {!last && (
            <Button
              type="button"
              size="lg"
              className="min-h-11 min-w-24 bg-primary-strong outline-hidden hover:bg-primary-strong-hover focus-visible:ring-2 focus-visible:ring-foreground disabled:bg-(--lds-color-surface-selected) disabled:text-control-border disabled:opacity-100"
              disabled={!currentAnswered || sending}
              onClick={advance}
            >
              Next
            </Button>
          )}
          {last && (
            <Button
              type="button"
              size="lg"
              className="min-h-11 min-w-35 bg-primary-strong outline-hidden hover:bg-primary-strong-hover focus-visible:ring-2 focus-visible:ring-foreground disabled:bg-(--lds-color-surface-selected) disabled:text-control-border disabled:opacity-100"
              disabled={answered === 0 && !sending}
              // Kept enabled while sending, so that it holds focus until the card closes.
              aria-disabled={sending || undefined}
              onClick={sending ? undefined : onSend}
            >
              {sending && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
              {sending ? 'Sending…' : several ? 'Send answers' : 'Send answer'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
