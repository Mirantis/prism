import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/format';
import { REQUEST_KIND_LABEL, formatUsd, withMentionNames } from '@/lib/spending';
import type { RequestSpend } from '@/types';
import { SpendingRequestDetails } from './spending-request-details';

/** One request in a conversation: the message it answered or what started it, expanding to its calls. */
export function SpendingRequestRow({ request }: { request: RequestSpend }) {
  const [open, setOpen] = useState(false);

  return (
    <li data-testid="spending-request" data-kind={request.kind}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/50">
          <ChevronRight aria-hidden="true" className={cn('mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <div className="min-w-0 flex-1">
            <p className={cn('truncate text-sm', request.preview ? 'text-foreground' : 'text-muted-foreground italic')}>
              {request.preview ? withMentionNames(request.preview) : REQUEST_KIND_LABEL[request.kind]}
            </p>
            <p className="text-xs text-muted-foreground">
              {request.preview ? `${REQUEST_KIND_LABEL[request.kind]} · ` : ''}
              {formatRelativeTime(request.firstCallAt)} · {request.calls} call{request.calls === 1 ? '' : 's'}
            </p>
          </div>
          <span className="shrink-0 text-sm font-medium text-strong tabular-nums">{formatUsd(request.costUsd)}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="pr-2 pb-2 pl-7.5">{open && <SpendingRequestDetails requestId={request.requestId} />}</CollapsibleContent>
      </Collapsible>
    </li>
  );
}
