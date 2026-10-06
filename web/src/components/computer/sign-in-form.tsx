import { useState, type FormEvent } from 'react';
import { LoaderCircle, LockKeyhole } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { computerRequest } from '@/api/computer';
import type { ComputerHelp } from '@lensapp/prism-client';

/** The runtime enters credentials into the website while Prism is paused. */
export function SignInForm({
  help,
  onCancel,
  /** Offered where the box is the whole of the request, so it can be refused there. */
  canDismiss = false,
  disabled = false,
}: {
  help: ComputerHelp;
  onCancel?: () => void;
  canDismiss?: boolean;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dismiss = async () => {
    setBusy(true);
    setError(null);
    try {
      await computerRequest(`/help/${help.id}`, { action: 'dismiss' });
      await queryClient.invalidateQueries({ queryKey: ['computer'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await computerRequest(`/help/${help.id}/credentials`, { username, password });
      setUsername('');
      setPassword('');
      await queryClient.invalidateQueries({ queryKey: ['computer'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form aria-label="Sign in for Prism" aria-busy={busy} className="space-y-4" onSubmit={(e) => void submit(e)}>
      {help.site && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Sign in to</p>
          <p className="break-all text-sm font-medium">{help.site}</p>
        </div>
      )}
      <FieldGroup className="gap-3">
        {/* The page's own shape: a second step of a sign-in asks for the password alone. */}
        {help.credentialFields !== 'password' && (
          <Field>
            <FieldLabel htmlFor={`sign-in-user-${help.id}`}>Username</FieldLabel>
            <Input
              id={`sign-in-user-${help.id}`}
              autoComplete="off"
              disabled={busy || disabled}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor={`sign-in-password-${help.id}`}>Password</FieldLabel>
          <Input
            id={`sign-in-password-${help.id}`}
            type="password"
            autoComplete="off"
            disabled={busy || disabled}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </FieldGroup>
      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <LockKeyhole aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        Your credentials are used to sign in to this website. Prism stays paused during sign-in.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || disabled || password.length === 0}>
          {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Hide
          </Button>
        )}
        {canDismiss && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy || disabled}
            onClick={() => void dismiss()}
          >
            Dismiss
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
