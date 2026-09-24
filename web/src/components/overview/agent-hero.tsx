import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Cpu, MessageSquare, Settings2, Sparkles } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/shared/status-pill';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { cn } from '@/lib/utils';
import type { AgentDetails } from '@/types';

/** The top of the Overview: who the agent is, what it runs on, and the way into a conversation. */
export function AgentHero({ details }: { details: AgentDetails | undefined }) {
  const agent = useAgent();
  const { data: model } = useQuery({
    queryKey: ['agent-model', agent.agentId],
    queryFn: () => runtimeApi.getModel(),
  });

  return (
    <section className="relative overflow-hidden rounded-2xl bg-card p-6 ring-1 ring-foreground/10 md:p-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 -right-24 size-80 rounded-full bg-primary/15 blur-3xl"
      />
      <img
        src="/prism-logo.svg"
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute -right-8 -bottom-10 hidden size-56 opacity-[0.05] lg:block"
      />
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-5">
          <div className="brand-tile flex size-16 shrink-0 items-center justify-center rounded-2xl">
            <img src="/prism-logo.svg" alt="" width={36} height={36} />
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="truncate text-3xl font-semibold tracking-tight text-strong">{agent.name}</h1>
              {details && <StatusPill status={details.status} />}
            </div>
            <p className="text-sm text-foreground/75">
              Your autonomous agent. It learns, remembers, and works on its own.
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Cpu className="size-3.5 shrink-0" />
                {model ? <span className="truncate font-mono">{model.model}</span> : <Skeleton className="h-3 w-40" />}
              </span>
              {details && (
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="size-3.5" />
                  Created {new Date(details.createdAt).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Link to="/profile" className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'px-3')}>
            <Settings2 />
            Edit profile
          </Link>
          <Link to="/chat" className={cn(buttonVariants({ size: 'lg' }), 'px-3 shadow-lg shadow-primary/20')}>
            <MessageSquare />
            Start chatting
          </Link>
        </div>
      </div>
    </section>
  );
}
