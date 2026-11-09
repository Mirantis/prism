import { useId } from 'react';
import { Textarea } from '@/components/ui/textarea';
import type { QuestionChoice } from '@/lib/question-card';
import { QuestionCardOption } from './question-card-option';

/** The count appears when fewer characters than this remain. */
const SHOW_COUNT_BELOW = 50;

/** The "Other…" row, and the text field it opens under itself. */
export function QuestionCardOther({
  type,
  name,
  questionNumber,
  maxLength,
  choice,
  onToggle,
  onText,
}: {
  type: 'radio' | 'checkbox';
  name: string;
  questionNumber: number;
  maxLength: number;
  choice: QuestionChoice;
  onToggle: () => void;
  onText: (text: string) => void;
}) {
  const countId = useId();
  // Counted as the field's maxLength counts, in UTF-16 code units.
  const left = maxLength - choice.otherText.length;
  const showCount = left < SHOW_COUNT_BELOW;
  // Spoken at these two points only. A paste that jumps past 20 is heard at 0.
  const announcement = left === 20 || left === 0 ? `${left} characters left` : '';
  return (
    <>
      <QuestionCardOption type={type} name={name} label="Other…" checked={choice.otherOpen} onChange={onToggle} />
      {choice.otherOpen && (
        <div className="animate-in pl-10 duration-150 ease-out fade-in-0 slide-in-from-top-1">
          <Textarea
            value={choice.otherText}
            onChange={(event) => onText(event.target.value)}
            placeholder="Type your answer"
            aria-label={`Your answer to question ${questionNumber}`}
            aria-describedby={showCount ? countId : undefined}
            maxLength={maxLength}
            className="min-h-9 border-muted-foreground outline-hidden"
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
    </>
  );
}
