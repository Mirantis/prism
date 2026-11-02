import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Code } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { runtimeApi } from '@/api/runtime-client';
import { CODING_AGENTS_QUERY_KEY } from '@/lib/coding-agents';
import type { CodingAgentId } from '@/types';
import { CodingAgentRow } from './coding-agent-row';
import { CodingAgentSignInDialog } from './coding-agent-sign-in-dialog';
import { CodingAgentTerms } from './coding-agent-terms';

/**
 * The Profile page's coding agents, each signed in to the person's own subscription or on
 * the deployment's models. `signIn` opens one's sign-in, as a link to it does.
 */
export function CodingAgentsCard({
  signIn,
  onSignInClosed,
}: {
  signIn?: { agent: CodingAgentId };
  onSignInClosed?: () => void;
}) {
  const { data: agents, error } = useQuery({
    queryKey: CODING_AGENTS_QUERY_KEY,
    queryFn: () => runtimeApi.codingAgents(),
  });
  // The dialog resumes the sign-in under way for the agent, or starts one. A link opens it
  // for an agent that asked in chat and waits.
  const [dialog, setDialog] = useState<{ agent: CodingAgentId; paused: boolean } | null>(
    signIn ? { agent: signIn.agent, paused: true } : null,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Code className="size-4 text-muted-foreground" />
          Coding agents
        </CardTitle>
        <p className="max-w-3xl text-sm text-foreground/70">
          Your agent hands longer, multi-step work to a coding agent: research, documents, slides, spreadsheets,
          analysis and code. It runs on the deployment's models, or on your own Claude or ChatGPT plan when you sign in.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        ) : agents ? (
          <ul className="grid gap-3 md:grid-cols-2">
            {agents.map((row) => (
              <CodingAgentRow
                key={row.agent}
                row={row}
                onSignIn={() => setDialog({ agent: row.agent, paused: false })}
              />
            ))}
          </ul>
        ) : (
          <Skeleton className="h-16" />
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          <CodingAgentTerms />
        </p>
      </CardContent>
      {dialog && (
        <CodingAgentSignInDialog
          agent={dialog.agent}
          paused={dialog.paused}
          onClose={() => {
            setDialog(null);
            onSignInClosed?.();
          }}
        />
      )}
    </Card>
  );
}
