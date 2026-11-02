import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  Clock,
  Ellipsis,
  ExternalLink,
  Loader2,
  LockKeyhole,
  Pause,
  TriangleAlert,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CopyButton } from '@/components/shared/copy-button';
import { runtimeApi } from '@/api/runtime-client';
import { ApiError } from '@/api/errors';
import {
  CODING_AGENT_COMPANY,
  CODING_AGENT_NAME,
  CODING_AGENT_PROVIDER,
  CODING_AGENTS_QUERY_KEY,
} from '@/lib/coding-agents';
import { cn } from '@/lib/utils';
import type { CodingAgentId, CodingAgentSignIn } from '@/types';
import { CodingAgentMark } from './coding-agent-mark';
import { CodingAgentTerms } from './coding-agent-terms';

/** How often a sign-in that finishes on the runtime's side is read again. */
const POLL_MS = 3000;

const EXPIRED = 'The sign-in link expired.';

type View =
  | { kind: 'loading' }
  | { kind: 'attempt'; attempt: CodingAgentSignIn }
  /** A request failed, or the runtime has no record of the sign-in. */
  | { kind: 'lost'; message: string };

const PRIMARY = 'h-10 w-full text-sm';
const MARK_SIZE = 56;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A state of the sign-in, centred under its symbol. */
function Status({
  icon,
  role,
  children,
}: {
  icon: React.ReactNode;
  role: 'status' | 'alert';
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      {icon}
      <p role={role} className="text-pretty">
        {children}
      </p>
    </div>
  );
}

/** One numbered step, with the control it needs under its line. */
function Step({ n, text, children }: { n: number; text: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-foreground tabular-nums"
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-0.5">
        <p className="text-foreground">{text}</p>
        {children}
      </div>
    </li>
  );
}

function Note({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </li>
  );
}

/**
 * Sign a coding agent in to the person's own subscription: resume the sign-in under way for
 * `agent`, or start one. Mounted while open. `paused` says the agent waits for it, as it does
 * when it asked in chat.
 */
export function CodingAgentSignInDialog({
  agent,
  paused = false,
  onClose,
}: {
  agent: CodingAgentId;
  paused?: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const provider = CODING_AGENT_PROVIDER[agent];
  const name = CODING_AGENT_NAME[agent];
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const mounted = useRef(true);
  const popup = useRef<HTMLDivElement>(null);

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

  const openSignIn = (primary: boolean) =>
    attempt?.url ? (
      <a
        href={attempt.url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          buttonVariants({ variant: primary ? 'default' : 'outline', size: 'lg' }),
          primary ? PRIMARY : 'self-start',
        )}
      >
        <ExternalLink />
        Open sign-in
      </a>
    ) : null;

  const spinner = <Loader2 aria-hidden="true" className="size-6 animate-spin text-muted-foreground" />;
  const warning = <TriangleAlert aria-hidden="true" className="size-7 text-warning" />;
  const clock = <Clock aria-hidden="true" className="size-7 text-muted-foreground" />;
  const newLink = (
    <Button size="lg" className={PRIMARY} onClick={() => void start()}>
      Get a new link
    </Button>
  );

  let body: React.ReactNode;
  if (view.kind === 'loading') {
    body = (
      <Status icon={spinner} role="status">
        Getting a sign-in link…
      </Status>
    );
  } else if (view.kind === 'lost') {
    body = (
      <>
        <Status icon={view.message === EXPIRED ? clock : warning} role="alert">
          {view.message}
        </Status>
        {newLink}
      </>
    );
  } else if (sending || view.attempt.status === 'checking') {
    body = (
      <Status icon={spinner} role="status">
        Checking…
      </Status>
    );
  } else if (view.attempt.status === 'signed_in') {
    body = (
      <>
        <Status icon={<CircleCheck aria-hidden="true" className="size-8 text-success" />} role="status">
          Signed in. {name} now runs on your {plan}.
        </Status>
        <Button size="lg" className={PRIMARY} onClick={close}>
          Done
        </Button>
      </>
    );
  } else if (view.attempt.status === 'failed') {
    body = (
      <>
        <Status icon={warning} role="alert">
          {view.attempt.error}
        </Status>
        {newLink}
      </>
    );
  } else if (view.attempt.status === 'expired') {
    body = (
      <>
        <Status icon={clock} role="alert">
          {EXPIRED}
        </Status>
        {newLink}
      </>
    );
  } else if (view.attempt.agent === 'codex') {
    const userCode = view.attempt.userCode ?? '';
    body = (
      <ol className="flex flex-col gap-5">
        <Step n={1} text="Open ChatGPT's sign-in page.">
          {openSignIn(true)}
        </Step>
        <Step n={2} text="Enter this code:">
          <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/60 py-2 pr-2 pl-4 ring-1 ring-border ring-inset">
            <code
              className="min-w-0 bg-transparent p-0 font-mono text-2xl font-semibold tracking-widest break-all text-strong select-all"
              data-testid="coding-agent-user-code"
            >
              {userCode}
            </code>
            <CopyButton text={userCode} label="Copy code" className="size-8 shrink-0" />
          </div>
        </Step>
        <Step n={3} text="Allow access. This updates when you're done.">
          <p role="status" className="flex items-center gap-2 text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />
            Waiting for you to finish on OpenAI's page…
          </p>
        </Step>
      </ol>
    );
  } else {
    const id = view.attempt.id;
    body = (
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim()) void sendCode(id);
        }}
      >
        <ol className="flex flex-col gap-5">
          <Step n={1} text="Open Claude's sign-in page.">
            {openSignIn(false)}
          </Step>
          <Step n={2} text="Sign in and allow access." />
          <Step n={3} text="Paste the code it shows.">
            <Label htmlFor="coding-agent-sign-in-code" className="sr-only">
              Code
            </Label>
            <Input
              id="coding-agent-sign-in-code"
              className="h-10 font-mono"
              placeholder="Code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={codeError ? true : undefined}
            />
            {codeError && (
              <p role="alert" className="text-xs text-destructive">
                {codeError}
              </p>
            )}
          </Step>
        </ol>
        <Button type="submit" size="lg" className={PRIMARY} disabled={!code.trim()}>
          Sign in
        </Button>
      </form>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      {/* The dialog opens while it fetches the link, so its first tabbable is the terms link: focus the dialog instead. */}
      <DialogContent
        ref={popup}
        initialFocus={popup}
        className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto px-6 pt-9 pb-6 sm:max-w-md"
      >
        <div className="flex items-center justify-center gap-3.5 text-muted-foreground" aria-hidden="true">
          <span
            className="grid shrink-0 place-items-center bg-background ring-1 ring-border ring-inset"
            style={{ width: MARK_SIZE, height: MARK_SIZE, borderRadius: MARK_SIZE * 0.24, padding: MARK_SIZE * 0.18 }}
          >
            <img src="/prism-logo.svg" alt="" className="size-full" />
          </span>
          <Ellipsis className="size-5" />
          <CodingAgentMark agent={agent} size={MARK_SIZE} />
        </div>
        <DialogHeader className="mt-5 items-center gap-2 text-center">
          <DialogTitle className="text-lg leading-tight font-semibold">Sign in to {provider}</DialogTitle>
          <DialogDescription className="leading-relaxed text-pretty">
            {name} does your agent's multi-step work: research, documents, slides, spreadsheets, analysis and code.
            Signed in, it runs on your own {provider} plan instead of the deployment's models.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-6 flex flex-col gap-4 text-sm">{body}</div>
        <ul className="mt-6 flex flex-col gap-2.5 border-t pt-5 text-xs leading-relaxed text-muted-foreground">
          <Note icon={LockKeyhole}>
            You sign in on {CODING_AGENT_COMPANY[agent]}'s own page. Your password never reaches this app.
          </Note>
          {paused && !signedIn && <Note icon={Pause}>Your agent is paused until you finish.</Note>}
          <Note icon={UserRound}>
            <CodingAgentTerms />
          </Note>
        </ul>
      </DialogContent>
    </Dialog>
  );
}
