import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { computerRequest } from '@/api/computer';
import type { ComputerHelp } from '@/types';

/**
 * The username and password for a sign-in Prism asked for.
 *
 * What is typed here goes to the runtime, which enters it in the browser and submits the
 * form. Prism is stopped for as long as that takes and is given neither value.
 */
export function SignInForm({
  help,
  onCancel,
  disabled = false,
}: {
  help: ComputerHelp;
  onCancel?: () => void;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await computerRequest(`/help/${help.id}/credentials`, { username, password });
      // Neither value is kept once it is on its way: the request resolves and this form
      // goes with it, but a refused one leaves the box on the page.
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
    <form aria-label="Sign in for Prism" className="space-y-3" onSubmit={(e) => void submit(e)}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`sign-in-user-${help.id}`}>Username</FieldLabel>
          <Input
            id={`sign-in-user-${help.id}`}
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`sign-in-password-${help.id}`}>Password</FieldLabel>
          <Input
            id={`sign-in-password-${help.id}`}
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </FieldGroup>
      {help.site && (
        <p className="text-xs text-muted-foreground">
          Prism types these into <span className="font-mono">{help.site}</span> and signs in. It
          never sees them.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || disabled || password.length === 0}>
          Sign in
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
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
