import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CopyButton } from '@/components/shared/copy-button';
import { runtimeApi } from '@/api/runtime-client';
import { ApiError } from '@/api/errors';
import { CODING_AGENT_PROVIDER, CODING_AGENTS_QUERY_KEY } from '@/lib/coding-agents';
import { cn } from '@/lib/utils';
import type { CodingAgentId, CodingAgentSignIn } from '@/types';

/** How often a sign-in that finishes on the runtime's side is read again. */
const POLL_MS = 3000;

const EXPIRED = 'The sign-in link expired.';

type View =
  | { kind: 'loading' }
  | { kind: 'attempt'; attempt: CodingAgentSignIn }
  /** A request failed, or the runtime has no record of the sign-in. */
  | { kind: 'lost'; message: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sign a coding agent in to the person's own subscription: resume the sign-in under way for
 * `agent`, or start one. Mounted while open.
 */
export function CodingAgentSignInDialog({
  agent,
  onClose,
}: {
  agent: CodingAgentId;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const provider = CODING_AGENT_PROVIDER[agent];
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const show = useCallback((next: View) => {
    if (mounted.current) setView(next);
  }, []);

  const start = useCallback(async () => {
    setView({ kind: 'loading' });
    setCode('');
    setCodeError(null);
    try {
      show({ kind: 'attempt', attempt: await runtimeApi.startCodingAgentSignIn(agent) });
    } catch (error) {
      show({ kind: 'lost', message: messageOf(error) });
    }
  }, [agent, show]);

  const load = useCallback(
    async (id: string) => {
      try {
        show({ kind: 'attempt', attempt: await runtimeApi.codingAgentSignIn(agent, id) });
      } catch (error) {
        // The runtime forgets a sign-in when it restarts.
        const lost = error instanceof ApiError && error.status === 404;
        show({ kind: 'lost', message: lost ? EXPIRED : messageOf(error) });
      }
    },
    [agent, show],
  );

  // Opening resumes the sign-in still under way for this agent, wherever it was started,
  // and starts one otherwise. React's development double mount keeps refs, so this opens
  // one sign-in, not two.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void (async () => {
      try {
        const running = (await runtimeApi.codingAgents()).find((row) => row.agent === agent)?.attempt;
        if (running) return show({ kind: 'attempt', attempt: running });
      } catch {
        // Starting reports what is wrong.
      }
      await start();
    })();
  }, [agent, show, start]);

  const attempt = view.kind === 'attempt' ? view.attempt : null;

  // A Codex sign-in and a code being checked finish on the runtime's side, so they are
  // read again after every reading until they do. A Claude sign-in waits for its code,
  // and is read again when its link expires.
  useEffect(() => {
    if (view.kind !== 'attempt' || sending) return;
    const { id, agent: kind, status, expiresAt } = view.attempt;
    const polled = status === 'checking' || (status === 'waiting' && kind === 'codex');
    if (!polled && status !== 'waiting') return;
    const delay = polled ? POLL_MS : Math.max(0, Date.parse(expiresAt) - Date.now());
    const timer = setTimeout(() => void load(id), delay);
    return () => clearTimeout(timer);
  }, [view, sending, load]);

  // The plan comes with the agent's row, read again once the sign-in succeeds.
  const signedIn = attempt?.status === 'signed_in';
  const { data: agents } = useQuery({
    queryKey: CODING_AGENTS_QUERY_KEY,
    queryFn: () => runtimeApi.codingAgents(),
    enabled: signedIn,
  });
  useEffect(() => {
    if (signedIn) void queryClient.invalidateQueries({ queryKey: CODING_AGENTS_QUERY_KEY });
  }, [signedIn, queryClient]);
  const plan = agents?.find((row) => row.agent === agent)?.account?.plan ?? `${provider} subscription`;

  const close = () => {
    void queryClient.invalidateQueries({ queryKey: CODING_AGENTS_QUERY_KEY });
    onClose();
  };

  const sendCode = async (id: string) => {
    setSending(true);
    setCodeError(null);
    try {
      show({ kind: 'attempt', attempt: await runtimeApi.sendClaudeSignInCode(id, code.trim()) });
    } catch (error) {
      // 409: the sign-in no longer waits for a code, so show where it is now.
      if (error instanceof ApiError && error.status === 409) await load(id);
      else if (mounted.current) setCodeError(messageOf(error));
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  const openSignIn = attempt?.url ? (
    <a
      href={attempt.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(buttonVariants({ variant: 'outline' }), 'self-start')}
    >
      <ExternalLink />
      Open sign-in
    </a>
  ) : null;

  const newLink = (
    <DialogFooter className="pt-0">
      <Button onClick={() => void start()}>Get a new link</Button>
    </DialogFooter>
  );

  let body: React.ReactNode;
  if (view.kind === 'loading') {
    body = <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Loading" />;
  } else if (view.kind === 'lost') {
    body = (
      <>
        <p role="alert">{view.message}</p>
        {newLink}
      </>
    );
  } else if (sending || view.attempt.status === 'checking') {
    body = (
      <p className="flex items-center gap-2" role="status">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        Checking…
      </p>
    );
  } else if (view.attempt.status === 'signed_in') {
    body = (
      <>
        <p role="status">Signed in. Coding tasks now use your {plan}.</p>
        <DialogFooter className="pt-0">
          <Button onClick={close}>Done</Button>
        </DialogFooter>
      </>
    );
  } else if (view.attempt.status === 'failed' || view.attempt.status === 'expired') {
    body = (
      <>
        <p role="alert">{view.attempt.status === 'failed' ? view.attempt.error : EXPIRED}</p>
        {newLink}
      </>
    );
  } else if (view.attempt.agent === 'codex') {
    const userCode = view.attempt.userCode ?? '';
    body = (
      <>
        <p>Open the sign-in page, sign in to your ChatGPT account, and enter this code:</p>
        <div className="flex items-center gap-2">
          <code
            className="rounded-lg bg-muted px-3 py-2 font-mono text-2xl tracking-widest select-all"
            data-testid="coding-agent-user-code"
          >
            {userCode}
          </code>
          <CopyButton text={userCode} label="Copy code" />
        </div>
        {openSignIn}
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Waiting for you to finish on OpenAI's page…
        </p>
      </>
    );
  } else {
    const id = view.attempt.id;
    body = (
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim()) void sendCode(id);
        }}
      >
        <p>Open the sign-in page, sign in to your Claude account, then paste the code it shows.</p>
        {openSignIn}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="coding-agent-sign-in-code">Code</Label>
          <Input
            id="coding-agent-sign-in-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {codeError && (
            <p role="alert" className="text-xs text-destructive">
              {codeError}
            </p>
          )}
        </div>
        <DialogFooter className="pt-0">
          <Button type="submit" disabled={!code.trim()}>
            Sign in
          </Button>
        </DialogFooter>
      </form>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign in to {provider}</DialogTitle>
          {!signedIn && <DialogDescription>Your agent is paused until you finish.</DialogDescription>}
        </DialogHeader>
        <div className="flex flex-col gap-4 text-sm">{body}</div>
      </DialogContent>
    </Dialog>
  );
}
