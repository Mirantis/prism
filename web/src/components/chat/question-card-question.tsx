import { useId, useRef, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { emptyChoice, isAnswered, setOtherText, toggleOption, type QuestionChoice } from '@/lib/question-card';
import type { QuestionCardQuestion as Question } from '@/types';
import { QuestionCardOption } from './question-card-option';
import { QuestionCardOther } from './question-card-other';

/** One question: its text, its numbered answer rows, the own-answer field and, once it has an answer, Clear. */
export function QuestionCardQuestion({
  question,
  questionNumber,
  otherMaxLength,
  choice,
  textRef,
  onChange,
  onPicked,
  onEnter,
}: {
  question: Question;
  questionNumber: number;
  otherMaxLength: number;
  choice: QuestionChoice;
  /** The question text, which takes focus when the card moves to this question. */
  textRef: RefObject<HTMLParagraphElement | null>;
  onChange: (choice: QuestionChoice) => void;
  /** A single-select option was chosen or chosen again by pointer or Space, not by moving through the group with an arrow key. */
  onPicked: () => void;
  onEnter: () => void;
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
        <p
          id={textId}
          ref={textRef}
          tabIndex={-1}
          className="col-start-1 row-start-1 text-base leading-6 font-semibold break-words text-strong outline-hidden"
        >
          {question.text}
          {question.multiSelect && ' '}
          {question.multiSelect && <span className="text-[0.8125rem] font-normal text-muted-foreground">Choose any</span>}
        </p>
        <div className="col-span-2 row-start-2 mt-2 -mx-2.5 flex flex-col gap-0.5">
          {question.options.map((option, index) => (
            <QuestionCardOption
              key={option.label}
              type={type}
              name={name}
              number={index + 1}
              label={option.label}
              detail={option.detail}
              recommended={question.recommended === option.label}
              checked={choice.options.includes(index)}
              inputRef={index === 0 ? firstOption : undefined}
              onChange={() => {
                onChange(toggleOption(choice, index, question.multiSelect));
                if (!question.multiSelect && !arrowing.current) onPicked();
              }}
              onReselect={() => {
                if (!arrowing.current) onPicked();
              }}
            />
          ))}
        </div>
        {question.allowOther && (
          <div className="col-span-2 row-start-3 -mx-2.5">
            <QuestionCardOther
              questionNumber={questionNumber}
              maxLength={otherMaxLength}
              text={choice.otherText}
              onText={(text) => onChange(setOtherText(choice, text, question.multiSelect))}
              onEnter={onEnter}
            />
          </div>
        )}
        {/* In the question's line, and last in the DOM so that it follows the answers in the tab order. */}
        {isAnswered(choice) && (
          <Button
            type="button"
            variant="ghost"
            className="col-start-2 row-start-1 -my-1 -mr-2 h-8 px-2 text-[0.8125rem] text-muted-foreground outline-hidden hover:text-strong"
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
