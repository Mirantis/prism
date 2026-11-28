import { useId, type KeyboardEvent } from 'react';
import { Textarea } from '@/components/ui/textarea';

/** The count appears when fewer characters than this remain. */
const SHOW_COUNT_BELOW = 50;

/** The field under the options for an answer of one's own. */
export function QuestionCardOther({
  questionNumber,
  maxLength,
  text,
  onText,
  onEnter,
}: {
  questionNumber: number;
  maxLength: number;
  text: string;
  onText: (text: string) => void;
  /** Enter without Shift. Shift+Enter starts a new line. */
  onEnter: () => void;
}) {
  const countId = useId();
  // Counted as the field's maxLength counts, in UTF-16 code units.
  const left = maxLength - text.length;
  const showCount = left < SHOW_COUNT_BELOW;
  // Spoken at these two points only. A paste that jumps past 20 is heard at 0.
  const announcement = left === 20 || left === 0 ? `${left} characters left` : '';

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onEnter();
  };

  return (
    <div className="mt-1.5 pl-[2.875rem]">
      <Textarea
        value={text}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Or write your own response"
        aria-label={`Your answer to question ${questionNumber}`}
        aria-describedby={showCount ? countId : undefined}
        maxLength={maxLength}
        className="min-h-11 scroll-mb-14 resize-none border-control-border bg-card py-2 text-[0.9375rem] leading-[1.375rem] text-strong outline-hidden md:text-[0.9375rem]"
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
  );
}
