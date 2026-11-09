import { useEffect, useId, useRef } from 'react';
import { Textarea } from '@/components/ui/textarea';
import type { QuestionChoice } from '@/lib/question-card';
import { QuestionCardOption } from './question-card-option';

/** The count appears when fewer characters than this remain. */
const SHOW_COUNT_BELOW = 50;

/** The "Other…" row, with the text field it opens inside itself. */
export function QuestionCardOther({
  type,
  name,
  questionNumber,
  maxLength,
  choice,
  isArrowing,
  onToggle,
  onText,
}: {
  type: 'radio' | 'checkbox';
  name: string;
  questionNumber: number;
  maxLength: number;
  choice: QuestionChoice;
  /** The last key was an arrow, so the person is moving through the group and keeps their place. */
  isArrowing: () => boolean;
  onToggle: () => void;
  onText: (text: string) => void;
}) {
  const countId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const focusWhenOpen = useRef(false);
  // Counted as the field's maxLength counts, in UTF-16 code units.
  const left = maxLength - choice.otherText.length;
  const showCount = left < SHOW_COUNT_BELOW;
  // Spoken at these two points only. A paste that jumps past 20 is heard at 0.
  const announcement = left === 20 || left === 0 ? `${left} characters left` : '';

  useEffect(() => {
    if (!choice.otherOpen || !focusWhenOpen.current) return;
    focusWhenOpen.current = false;
    field.current?.focus();
    // Its bottom margin keeps the field clear of the fade above the composer.
    field.current?.scrollIntoView({ block: 'nearest' });
  }, [choice.otherOpen]);

  return (
    <QuestionCardOption
      type={type}
      name={name}
      label="Other…"
      checked={choice.otherOpen}
      onChange={() => {
        focusWhenOpen.current = !choice.otherOpen && !isArrowing();
        onToggle();
      }}
    >
      {choice.otherOpen && (
        // Starts at the label's edge: the row's padding, the indicator and the gap.
        <div className="animate-in pr-3.5 pb-3 pl-11 duration-150 ease-out fade-in-0 slide-in-from-top-1">
          <Textarea
            ref={field}
            value={choice.otherText}
            onChange={(event) => onText(event.target.value)}
            placeholder="Type your answer"
            aria-label={`Your answer to question ${questionNumber}`}
            aria-describedby={showCount ? countId : undefined}
            maxLength={maxLength}
            className="min-h-11 scroll-mb-14 resize-none border-control-border bg-card py-2.5 text-[0.9375rem] leading-[1.375rem] text-strong outline-hidden md:text-[0.9375rem]"
            rows={1}
          />
          {showCount && (
            <p id={countId} className="mt-1 text-xs text-muted-foreground" data-testid="question-card-count">
              {left} {left === 1 ? 'character' : 'characters'} left
            </p>
          )}
          <p role="status" className="sr-only" data-testid="question-card-count-announcement">
            {announcement}
          </p>
        </div>
      )}
    </QuestionCardOption>
  );
}
