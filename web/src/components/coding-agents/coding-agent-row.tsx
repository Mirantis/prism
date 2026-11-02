import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { runtimeApi } from '@/api/runtime-client';
import { CODING_AGENT_PROVIDER, CODING_AGENTS_QUERY_KEY } from '@/lib/coding-agents';
import type { CodingAgentSummary } from '@/types';

/** One coding agent on the Profile page: what its coding tasks run on, and how to change it. */
export function CodingAgentRow({
  row,
  onSignIn,
}: {
  row: CodingAgentSummary;
  onSignIn: () => void;
}) {
  const queryClient = useQueryClient();
  const provider = CODING_AGENT_PROVIDER[row.agent];
  const [confirming, setConfirming] = useState(false);

  const signOut = useMutation({
    mutationFn: () => runtimeApi.signOutCodingAgent(row.agent),
    onSuccess: (updated) => {
      queryClient.setQueryData<CodingAgentSummary[]>(CODING_AGENTS_QUERY_KEY, (rows) =>
        rows?.map((item) => (item.agent === updated.agent ? updated : item)),
      );
      setConfirming(false);
    },
  });

  const status = !row.available
    ? 'Not available on this agent'
    : !row.subscription
      ? "Uses the deployment's models"
      : row.account
        ? `Your ${row.account.plan} · ${row.account.email}`
        : 'Signed out. Coding tasks fail until you sign in again.';

  let action: React.ReactNode = null;
  if (row.available && row.subscription && row.account) {
    action = (
      <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
        Sign out
      </Button>
    );
  } else if (row.available) {
    action = (
      <Button size="sm" onClick={onSignIn}>
        Sign in
      </Button>
    );
  }

  return (
    <li aria-label={row.name} className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/15 p-3.5 ring-1 ring-border ring-inset">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{row.name}</span>
        <span className="text-sm break-words text-muted-foreground">{status}</span>
        {signOut.error && (
          <span role="alert" className="text-xs text-destructive">
            {signOut.error.message}
          </span>
        )}
      </div>
      {action}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of {provider}?</AlertDialogTitle>
            <AlertDialogDescription>Coding tasks go back to the deployment's models.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={signOut.isPending} onClick={() => signOut.mutate()}>
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
