import { useState } from 'react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, Wrench } from 'lucide-react';
import ToolCallCard from './tool-call-card';
import type { ToolCallRecord } from '@lensapp/prism-client';

interface ChatToolCallsProps {
  toolCalls: ToolCallRecord[];
}

/** The tools a reply used, folded into one chip that opens into the calls themselves. */
export default function ChatToolCalls({ toolCalls }: ChatToolCallsProps) {
  const [open, setOpen] = useState(false);
  if (toolCalls.length === 0) return null;
  const failCount = toolCalls.filter((tc) => !tc.success).length;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="inline-flex h-7 items-center gap-1.5 rounded-full bg-muted/25 pr-2.5 pl-2 text-xs text-muted-foreground ring-1 ring-border transition-colors ring-inset outline-none hover:bg-muted/40 hover:text-strong focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Wrench className="size-3.5" />
        <span>
          {toolCalls.length} tool{toolCalls.length !== 1 ? 's' : ''} used
        </span>
        {failCount > 0 && (
          <Badge variant="destructive" className="ml-0.5 h-4 px-1.5 text-[10px]">
            {failCount} failed
          </Badge>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 flex flex-col gap-0.5 rounded-xl bg-muted/15 p-1.5 ring-1 ring-border ring-inset">
          {toolCalls.map((tc, idx) => (
            <ToolCallCard key={idx} tc={tc} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
