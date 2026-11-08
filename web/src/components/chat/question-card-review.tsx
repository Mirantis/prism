import { answerLabels } from '@/lib/question-card';
import type { QuestionCardBlock } from '@/types';

/** A closed card's questions, read-only, each with its answer when the card was answered here. */
export function QuestionCardReview({ card }: { card: QuestionCardBlock }) {
  const several = card.questions.length > 1;
  return (
    <ol className="mt-2 flex flex-col gap-3">
      {card.questions.map((question, index) => {
        const labels = answerLabels(question, card.answers?.[index]);
        return (
          <li key={`${index}-${question.text}`} className="min-w-0">
            {question.header && <p className="text-xs font-medium break-words text-muted-foreground">{question.header}</p>}
            <p className="font-medium break-words text-strong">
              {several && `${index + 1}. `}
              {question.text}
            </p>
            {card.status === 'answered' && (
              <p className={labels.length > 0 ? 'break-words text-foreground' : 'text-muted-foreground'}>
                {labels.length > 0 ? labels.join(', ') : 'No answer'}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
