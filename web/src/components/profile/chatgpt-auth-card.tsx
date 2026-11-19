import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, KeyRound, LogOut } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { runtimeApi } from '@/api/runtime-client';

export const CHATGPT_AUTH_QUERY_KEY = ['chatgpt-auth-status'] as const;

/**
 * Profile card for signing Prism into the user's ChatGPT subscription when
 * `LLM_PROVIDER=chatgpt`. Renders nothing on other providers.
 */
export function ChatGptAuthCard() {
  const queryClient = useQueryClient();
  const [waitingForCallback, setWaitingForCallback] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: status } = useQuery({
    queryKey: CHATGPT_AUTH_QUERY_KEY,
    queryFn: () => runtimeApi.chatGptAuthStatus(),
    refetchInterval: waitingForCallback ? 2000 : false,
  });

  if (waitingForCallback && status?.signedIn) {
    setWaitingForCallback(false);
  }

  const startMut = useMutation({
    mutationFn: () => runtimeApi.startChatGptSignIn(),
    onSuccess: ({ authorizeUrl }) => {
      setActionError(null);
      setWaitingForCallback(true);
      window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
    },
    onError: (err: Error) => {
      setActionError(err.message);
    },
  });

  const signOutMut = useMutation({
    mutationFn: () => runtimeApi.signOutChatGpt(),
    onSuccess: (next) => {
      setActionError(null);
      setWaitingForCallback(false);
      queryClient.setQueryData(CHATGPT_AUTH_QUERY_KEY, next);
    },
    onError: (err: Error) => {
      setActionError(err.message);
    },
  });

  if (!status?.enabled) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4 text-muted-foreground" />
          ChatGPT subscription
        </CardTitle>
        <p className="max-w-3xl text-sm text-foreground/70">
          Sign in with your ChatGPT account to run Prism on your ChatGPT subscription plan via OpenAI&rsquo;s OAuth flow.
          Tokens stay local to this runtime.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/15 p-3.5 ring-1 ring-border ring-inset">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted/40 px-2.5 text-xs font-medium ring-1 ring-border ring-inset">
              <span
                className={
                  status.signedIn
                    ? 'size-2 rounded-full bg-emerald-500'
                    : 'size-2 rounded-full bg-muted-foreground/50'
                }
              />
              {status.signedIn ? 'Signed in' : waitingForCallback ? 'Waiting for browser sign-in' : 'Not signed in'}
            </span>
            {status.signedIn && status.email && (
              <span className="text-sm text-muted-foreground">{status.email}</span>
            )}
          </div>
          {status.signedIn ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => signOutMut.mutate()}
              disabled={signOutMut.isPending}
            >
              <LogOut className="size-3.5" />
              Sign out
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => startMut.mutate()}
              disabled={startMut.isPending}
            >
              <ExternalLink className="size-3.5" />
              Sign in with ChatGPT
            </Button>
          )}
        </div>
        {actionError && (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
