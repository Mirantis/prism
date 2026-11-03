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
import { CodingAgentMark } from './coding-agent-mark';

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
        : 'Signed out. Its work fails until you sign in again.';

  const signOutButton = (
    <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
      Sign out
    </Button>
  );
  const signInButton = (
    <Button size="sm" onClick={onSignIn}>
      Sign in
    </Button>
  );
  // Signed out with the switch still on: sign in again, or sign out to go back to the deployment's
  // models, unless the deployment holds the switch on.
  const canSignOut = row.subscription && (row.account !== null || !row.forced);
  const canSignIn = !row.subscription || row.account === null;
  const action = !row.available ? null : canSignOut && canSignIn ? (
    <div className="flex shrink-0 gap-2">
      {signOutButton}
      {signInButton}
    </div>
  ) : canSignOut ? (
    signOutButton
  ) : (
    signInButton
  );

  return (
    <li
      aria-label={row.name}
      className="flex items-center gap-3 rounded-xl bg-muted/15 p-3.5 ring-1 ring-border ring-inset"
    >
      <CodingAgentMark agent={row.agent} />
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
            <AlertDialogDescription>
              {row.forced
                ? `The deployment always runs ${row.name} on your subscription, so its work fails until you sign in again.`
                : `${row.name} goes back to the deployment's models.`}
            </AlertDialogDescription>
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
