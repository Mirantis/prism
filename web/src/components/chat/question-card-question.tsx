import { useId } from 'react';
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

/** One question: its legend, its answer rows and, once it has an answer, Clear. */
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
  const hintId = useId();
  const type = question.multiSelect ? 'checkbox' : 'radio';
  return (
    <fieldset className="relative min-w-0" aria-describedby={question.multiSelect ? hintId : undefined}>
      {/* Floated, so that the legend is in normal flow and Clear lines up with its top. */}
      <legend className="float-left w-full pr-16">
        <span className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-1">
          {showNumber && <span className="col-start-1 row-start-2 font-medium text-strong">{questionNumber}.</span>}
          {question.header && (
            <span className="col-start-2 row-start-1 text-xs font-medium break-words text-muted-foreground">
              {question.header}
            </span>
          )}
          <span className="col-start-2 row-start-2 font-medium break-words text-strong">{question.text}</span>
        </span>
      </legend>
      {question.multiSelect && (
        <p id={hintId} className="clear-both pt-0.5 text-xs text-muted-foreground">
          Choose any
        </p>
      )}
      <div className="clear-both flex flex-col gap-2 pt-2">
        {question.options.map((option, index) => (
          <QuestionCardOption
            key={option.label}
            type={type}
            name={name}
            label={option.label}
            detail={option.detail}
            recommended={question.recommended === option.label}
            checked={choice.options.includes(index)}
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
            onToggle={() => onChange(toggleOther(choice, question.multiSelect))}
            onText={(otherText) => onChange({ ...choice, otherText })}
          />
        )}
      </div>
      {/* Placed in the header line, and last in the DOM so that it follows the options in the tab order. */}
      {isAnswered(choice) && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="absolute top-0 right-0 text-muted-foreground"
          aria-label={`Clear answer to question ${questionNumber}`}
          onClick={() => onChange(emptyChoice())}
        >
          Clear
        </Button>
      )}
    </fieldset>
  );
}
