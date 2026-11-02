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

const LINK = 'underline underline-offset-4 hover:text-foreground';

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
  // The dialog resumes the sign-in under way for the agent, or starts one.
  const [dialog, setDialog] = useState<CodingAgentId | null>(signIn?.agent ?? null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Code className="size-4 text-muted-foreground" />
          Coding agents
        </CardTitle>
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
                onSignIn={() => setDialog(row.agent)}
              />
            ))}
          </ul>
        ) : (
          <Skeleton className="h-16" />
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Use your own Claude or ChatGPT subscription only on an agent nobody else uses.{' '}
          <a className={LINK} href="https://code.claude.com/docs/en/legal-and-compliance" target="_blank" rel="noopener noreferrer">
            Anthropic's
          </a>{' '}
          and{' '}
          <a className={LINK} href="https://openai.com/policies/row-terms-of-use/" target="_blank" rel="noopener noreferrer">
            OpenAI's
          </a>{' '}
          terms let only the subscriber use it, and a shared agent can get your account blocked.
        </p>
      </CardContent>
      {dialog && (
        <CodingAgentSignInDialog
          agent={dialog}
          onClose={() => {
            setDialog(null);
            onSignInClosed?.();
          }}
        />
      )}
    </Card>
  );
}
