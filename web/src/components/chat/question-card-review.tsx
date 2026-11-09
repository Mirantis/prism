import { answerLabels } from '@/lib/question-card';
import type { QuestionCardBlock } from '@/types';

/** A closed card's questions, read-only, each with its answer when the card was answered here. */
export function QuestionCardReview({ card }: { card: QuestionCardBlock }) {
  const several = card.questions.length > 1;
  return (
    <div className="mt-3">
      {card.intro && (
        <p className="mb-3 text-[0.9375rem] leading-6 break-words text-foreground" data-testid="question-card-intro">
          {card.intro}
        </p>
      )}
      <div className="flex flex-col gap-3">
        {card.questions.map((question, index) => {
          const labels = answerLabels(question, card.answers?.[index]);
          return (
            <div key={`${index}-${question.text}`} className="min-w-0">
              <p className="break-words text-muted-foreground">
                {several && `${index + 1}. `}
                {question.text}
              </p>
              {card.status === 'answered' && labels.length === 0 && <p className="text-muted-foreground">No answer</p>}
              {card.status === 'answered' &&
                labels.map((label, at) => (
                  <p key={`${at}-${label}`} className="text-[0.9375rem] leading-[1.375rem] break-words text-strong">
                    {label}
                  </p>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
