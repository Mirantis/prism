import { useState } from 'react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, Wrench } from 'lucide-react';
import ToolCallCard from './tool-call-card';
import type { ToolCallRecord } from '@/types';

interface ChatToolCallsProps {
  toolCalls: ToolCallRecord[];
}

export default function ChatToolCalls({ toolCalls }: ChatToolCallsProps) {
  const [open, setOpen] = useState(false);
  if (toolCalls.length === 0) return null;
  const failCount = toolCalls.filter((tc) => !tc.success).length;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Wrench className="size-3.5" />
        <span>
          {toolCalls.length} tool{toolCalls.length !== 1 ? 's' : ''} used
        </span>
        {failCount > 0 && (
          <Badge variant="destructive" className="ml-1 h-4 text-[10px] px-1.5">
            {failCount} failed
          </Badge>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 flex flex-col gap-0.5">
          {toolCalls.map((tc, idx) => (
            <ToolCallCard key={idx} tc={tc} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
