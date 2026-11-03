import { useState } from 'react';
import { ChevronRight, CircleCheck } from 'lucide-react';
import { CODING_AGENT_NAME, CODING_AGENT_PROVIDER } from '@/lib/coding-agents';
import { cn } from '@/lib/utils';
import type { CodingAgentSignInBlock } from '@/types';
import { CodingAgentMark } from './coding-agent-mark';
import { CodingAgentSignInDialog } from './coding-agent-sign-in-dialog';

const CARD = 'flex w-full max-w-md items-center gap-3 rounded-xl border bg-card p-3 pr-4 text-left text-sm shadow-sm';

/** The agent asks, in the chat, for its coding agent to be signed in. The whole card opens the sign-in. */
export function ChatCodingAgentSignIn({ block }: { block: CodingAgentSignInBlock }) {
  const [open, setOpen] = useState(false);
  const provider = CODING_AGENT_PROVIDER[block.agent];
  const name = CODING_AGENT_NAME[block.agent];

  if (block.status === 'signed_in') {
    return (
      <div role="status" aria-label="Coding agent sign-in" className={CARD}>
        <CodingAgentMark agent={block.agent} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-semibold text-strong">Signed in to {provider}</span>
          <span className="text-muted-foreground">
            {name} runs on your {provider} plan
          </span>
        </span>
        <CircleCheck aria-hidden="true" className="size-5 shrink-0 text-success" />
      </div>
    );
  }

  return (
    <section aria-label="Coding agent sign-in" className="w-full max-w-md">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          CARD,
          'group transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        )}
      >
        <CodingAgentMark agent={block.agent} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-semibold text-strong">Sign in to {provider}</span>
          <span className="text-muted-foreground">
            Run {name} on your own {provider} plan
          </span>
        </span>
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        />
      </button>
      <p className="mt-1.5 px-1 text-xs text-muted-foreground">Never paste a sign-in code into chat.</p>
      {open && <CodingAgentSignInDialog agent={block.agent} onClose={() => setOpen(false)} />}
    </section>
  );
}
