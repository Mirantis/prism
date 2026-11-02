import { useState } from 'react';
import { CircleCheck, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CODING_AGENT_PROVIDER } from '@/lib/coding-agents';
import type { CodingAgentSignInBlock } from '@/types';
import { CodingAgentSignInDialog } from './coding-agent-sign-in-dialog';

/** The agent asks, in the chat, for its coding agent to be signed in. */
export function ChatCodingAgentSignIn({ block }: { block: CodingAgentSignInBlock }) {
  const [open, setOpen] = useState(false);
  const provider = CODING_AGENT_PROVIDER[block.agent];

  if (block.status === 'signed_in') {
    return (
      <div
        role="status"
        aria-label="Coding agent sign-in"
        className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
      >
        <CircleCheck className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">Signed in to {provider}</span>
      </div>
    );
  }

  return (
    <section
      aria-label="Coding agent sign-in"
      className="flex w-full max-w-md flex-wrap items-center gap-3 rounded-xl border border-primary/20 bg-card px-4 py-3 text-sm shadow-sm"
    >
      <KeyRound className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 font-medium text-foreground">Sign in to {provider} for coding tasks</p>
      <Button size="sm" onClick={() => setOpen(true)}>
        Sign in
      </Button>
      {open && (
        <CodingAgentSignInDialog agent={block.agent} onClose={() => setOpen(false)} />
      )}
    </section>
  );
}
