import { useState, type RefObject } from 'react';
import { ChevronRight, CircleCheck, MessageCircle } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { storedAnsweredCount } from '@/lib/question-card';
import type { Viewer } from '@/lib/chat-socket/protocol';
import type { QuestionCardBlock } from '@/types';
import { QuestionCardReview } from './question-card-review';

function answeredTitle(card: QuestionCardBlock, viewer: Viewer | undefined): string {
  if (!card.answeredBy) return 'Answered';
  return card.answeredBy.id === viewer?.id ? 'Answered by you' : `Answered by ${card.answeredBy.name}`;
}

/** A card that no longer waits: one line, and the questions behind a disclosure. */
export function QuestionCardClosed({
  card,
  viewer,
  notice,
  titleId,
  titleRef,
}: {
  card: QuestionCardBlock;
  viewer: Viewer | undefined;
  /** What this person needs to know about this card. The card's status region announces it. */
  notice: string | null;
  titleId: string;
  titleRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const inChat = card.status === 'answered_in_chat';
  const total = card.questions.length;
  const Icon = inChat ? MessageCircle : CircleCheck;
  const title = inChat ? 'Answered in chat' : answeredTitle(card, viewer);
  return (
    <>
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className={`mt-0.5 size-5 shrink-0 ${inChat ? 'text-muted-foreground' : 'text-primary'}`} />
        <div className="min-w-0">
          <h3
            id={titleId}
            ref={titleRef}
            tabIndex={-1}
            className="rounded-sm font-semibold break-words text-strong outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {title}
          </h3>
          {!inChat && total > 1 && (
            <p className="mt-0.5 text-muted-foreground">
              {storedAnsweredCount(card)} of {total} answered
            </p>
          )}
          {notice && (
            <p aria-hidden="true" className="mt-0.5 break-words text-muted-foreground" data-testid="question-card-notice">
              {notice}
            </p>
          )}
        </div>
      </div>
      <Collapsible open={open} onOpenChange={setOpen} className="mt-2 pl-8">
        <CollapsibleTrigger
          aria-label={`${open ? 'Hide' : 'Show'} questions, ${title}`}
          className="-ml-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[0.8rem] text-muted-foreground outline-hidden hover:bg-muted hover:text-strong focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRight aria-hidden="true" className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
          {open ? 'Hide questions' : 'Show questions'}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <QuestionCardReview card={card} />
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}
