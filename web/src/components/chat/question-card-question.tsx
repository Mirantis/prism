import { useId, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  isAnswered,
  toggleOption,
  toggleOther,
  emptyChoice,
  type QuestionChoice,
} from '@/lib/question-card';
import type { QuestionCardQuestion as Question } from '@/types';
import { QuestionCardOption } from './question-card-option';
import { QuestionCardOther } from './question-card-other';

/** One question: its text, its answer rows and, once it has an answer, Clear. */
export function QuestionCardQuestion({
  question,
  questionNumber,
  showNumber,
  otherMaxLength,
  choice,
  onChange,
}: {
  question: Question;
  questionNumber: number;
  showNumber: boolean;
  otherMaxLength: number;
  choice: QuestionChoice;
  onChange: (choice: QuestionChoice) => void;
}) {
  const name = useId();
  const textId = useId();
  const firstOption = useRef<HTMLInputElement>(null);
  const arrowing = useRef(false);
  const type = question.multiSelect ? 'checkbox' : 'radio';
  return (
    <fieldset
      className="min-w-0"
      aria-labelledby={textId}
      onKeyDownCapture={(event) => {
        arrowing.current = event.key.startsWith('Arrow');
      }}
      onPointerDownCapture={() => {
        arrowing.current = false;
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
        <p id={textId} className="col-start-1 row-start-1 text-[0.9375rem] leading-[1.375rem] font-semibold break-words text-strong">
          {showNumber && `${questionNumber}. `}
          {question.text}
          {question.multiSelect && ' '}
          {question.multiSelect && <span className="text-[0.8125rem] font-normal text-muted-foreground">Choose any</span>}
        </p>
        <div className="col-span-2 row-start-2 mt-2.5 flex flex-col gap-1.5">
          {question.options.map((option, index) => (
            <QuestionCardOption
              key={option.label}
              type={type}
              name={name}
              label={option.label}
              detail={option.detail}
              recommended={question.recommended === option.label}
              checked={choice.options.includes(index)}
              inputRef={index === 0 ? firstOption : undefined}
              onChange={() => onChange(toggleOption(choice, index, question.multiSelect))}
            />
          ))}
          {question.allowOther && (
            <QuestionCardOther
              type={type}
              name={name}
              questionNumber={questionNumber}
              maxLength={otherMaxLength}
              choice={choice}
              isArrowing={() => arrowing.current}
              onToggle={() => onChange(toggleOther(choice, question.multiSelect))}
              onText={(otherText) => onChange({ ...choice, otherText })}
            />
          )}
        </div>
        {/* In the question's line, and last in the DOM so that it follows the options in the tab order. */}
        {isAnswered(choice) && (
          <Button
            type="button"
            variant="ghost"
            className="col-start-2 row-start-1 -my-[0.3125rem] -mr-2 h-8 px-2 text-[0.8125rem] text-muted-foreground outline-hidden hover:text-strong"
            aria-label={`Clear answer to question ${questionNumber}`}
            onClick={() => {
              // Clear leaves with the answer, so focus moves first.
              firstOption.current?.focus();
              onChange(emptyChoice());
            }}
          >
            Clear
          </Button>
        )}
      </div>
    </fieldset>
  );
}
