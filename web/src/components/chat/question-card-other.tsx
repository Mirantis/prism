import { Textarea } from '@/components/ui/textarea';
import type { QuestionChoice } from '@/lib/question-card';
import { QuestionCardOption } from './question-card-option';

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
            maxLength={maxLength}
            className="min-h-9 border-muted-foreground"
            rows={1}
          />
        </div>
      )}
    </>
  );
}
