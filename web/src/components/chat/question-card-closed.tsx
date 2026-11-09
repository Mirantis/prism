import { useState, type RefObject } from 'react';
import { ChevronDown, CircleCheck, MessageCircle } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { storedAnsweredCount } from '@/lib/question-card';
import type { Viewer } from '@/lib/chat-socket/protocol';
import type { QuestionCardBlock } from '@/types';
import { QuestionCardReview } from './question-card-review';

function answeredTitle(card: QuestionCardBlock, viewer: Viewer | undefined): string {
  if (!card.answeredBy) return 'Answered';
  return card.answeredBy.id === viewer?.id ? 'Answered by you' : `Answered by ${card.answeredBy.name}`;
}

/** A card that no longer waits: its title and a disclosure on one line, then anything the person needs to know. */
export function QuestionCardClosed({
  card,
  viewer,
  notice,
  titleRef,
}: {
  card: QuestionCardBlock;
  viewer: Viewer | undefined;
  /** What this person needs to know about this card. The card's status region announces it. */
  notice: string | null;
  titleRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const inChat = card.status === 'answered_in_chat';
  const total = card.questions.length;
  const answered = storedAnsweredCount(card);
  const Icon = inChat ? MessageCircle : CircleCheck;
  const title = inChat ? 'Answered in chat' : answeredTitle(card, viewer);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className={`size-[1.125rem] shrink-0 ${inChat ? 'text-muted-foreground' : 'text-primary'}`} />
        <h3
          ref={titleRef}
          tabIndex={-1}
          className="min-w-0 flex-1 rounded-sm font-semibold break-words text-strong outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {title}
        </h3>
        <CollapsibleTrigger
          aria-label={`${open ? 'Hide' : 'Show'} questions, ${title}`}
          className="-mr-1.5 inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[0.8125rem] text-muted-foreground outline-hidden hover:bg-muted hover:text-strong focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? 'Hide questions' : 'Show questions'}
          <ChevronDown aria-hidden="true" className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </CollapsibleTrigger>
      </div>
      {!inChat && answered < total && total > 1 && (
        <p className="mt-1 text-muted-foreground">
          {answered} of {total} answered
        </p>
      )}
      {notice && (
        <p aria-hidden="true" className="mt-1 break-words text-muted-foreground" data-testid="question-card-notice">
          {notice}
        </p>
      )}
      <CollapsibleContent>
        <QuestionCardReview card={card} />
      </CollapsibleContent>
    </Collapsible>
  );
}
