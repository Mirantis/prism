import { useQuery } from '@tanstack/react-query';
import { Link, type LinkProps } from '@tanstack/react-router';
import { ArrowRight, Check, Clock, MessageSquare, MessagesSquare, TriangleAlert, Webhook } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { IconTile } from '@/components/shared/icon-tile';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionHeader } from '@/components/layout/section-header';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { cn } from '@/lib/utils';
import type { Tone } from '@/lib/tones';
import { useRecentThreads } from '@/hooks/use-recent-threads';
import { useSlackStatus } from '@/hooks/use-slack-status';

interface Step {
  key: string;
  to: LinkProps['to'];
  icon: typeof Clock;
  tone: Tone;
  title: string;
  description: string;
  done: boolean;
}

/** The first things to set up, each ticked off once it is done, and the one to do next. */
export function SetupChecklist() {
  const agent = useAgent();
  const threads = useRecentThreads();
  const slack = useSlackStatus();
  const tasks = useQuery({
    queryKey: ['cron-tasks', agent.agentId],
    queryFn: () => runtimeApi.listCronTasks(),
  });
  const subscriptions = useQuery({
    queryKey: ['webhook-subscriptions', agent.agentId],
    queryFn: () => runtimeApi.listWebhookSubscriptions(),
  });
  const receiver = useQuery({
    queryKey: ['webhook-receiver', agent.agentId],
    queryFn: () => runtimeApi.getWebhookReceiver(),
  });

  // Every answer is in before anything is ticked, so the ticks and the Next marker land together.
  const settled =
    !threads.isPending &&
    !slack.isLoading &&
    !tasks.isPending &&
    !subscriptions.isPending &&
    !receiver.isPending;
  // An answer that failed is not an unticked step: the list says so and offers a retry instead.
  const failed =
    threads.isError || slack.isError || tasks.isError || subscriptions.isError || receiver.isError;
  const retry = () => {
    void threads.refetch();
    slack.refetch();
    void tasks.refetch();
    void subscriptions.refetch();
    void receiver.refetch();
  };

  const slackStep: Step[] = slack.workspace
    ? [
        {
          key: 'slack',
          to: '/channels',
          icon: MessagesSquare,
          tone: 'teal',
          title: 'Link it to Slack',
          description: 'DM your agent or have it watch a channel.',
          done: slack.isLinked,
        },
      ]
    : [];

  const steps: Step[] = [
    {
      key: 'conversation',
      to: '/chat',
      icon: MessageSquare,
      tone: 'primary',
      title: 'Have a first conversation',
      description: 'Tell your agent what to watch and how to act.',
      // A thread is titled from its first message, so a title means somebody said something.
      // The empty thread that opening Chat creates has none and does not count.
      done: (threads.data ?? []).some((thread) => Boolean(thread.title)),
    },
    // Only with a Slack workspace connected: linking needs one, and that is set in the
    // runtime's environment rather than here.
    ...slackStep,
    {
      key: 'task',
      to: '/cron',
      icon: Clock,
      tone: 'warning',
      title: 'Schedule a recurring task',
      description: 'Run checks and reports on your schedule.',
      // A task that runs once, or one that is paused, is not a schedule.
      done: (tasks.data ?? []).some((task) => task.recurring && task.isActive),
    },
    {
      key: 'webhook',
      to: '/webhooks',
      icon: Webhook,
      tone: 'success',
      title: 'Trigger it from another system',
      description: 'Give an alerting or CI system its own endpoint.',
      // A subscription reaches the agent only while the receiver is on.
      done: receiver.data?.enabled === true && (subscriptions.data?.length ?? 0) > 0,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const nextKey = steps.find((s) => !s.done)?.key;

  if (failed) {
    return (
      <section className="space-y-3" data-testid="setup-checklist">
        <SectionHeader title="Set up your agent" />
        <Card>
          <EmptyState
            icon={TriangleAlert}
            title="Setup status could not be read"
            action={
              <Button variant="outline" size="sm" onClick={retry}>
                Try again
              </Button>
            }
            className="py-8"
          />
        </Card>
      </section>
    );
  }

  if (!settled) {
    return (
      <section className="space-y-3" data-testid="setup-checklist">
        <SectionHeader title="Set up your agent" />
        <div className="grid gap-2.5">
          {steps.map((step) => (
            <Skeleton key={step.key} className="h-16 rounded-xl" />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="setup-checklist">
      <SectionHeader
        title={doneCount === steps.length ? 'Your agent is set up' : 'Set up your agent'}
        actions={
          <span className="text-xs text-muted-foreground tabular-nums" data-testid="setup-progress">
            {doneCount} of {steps.length} done
          </span>
        }
      />
      <div
        className="h-1 overflow-hidden rounded-full bg-muted/40"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={doneCount}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${(doneCount / steps.length) * 100}%` }}
        />
      </div>
      <div className="grid gap-2.5">
        {steps.map((step) => (
          <Link
            key={step.key}
            to={step.to}
            data-testid="setup-step"
            data-step={step.key}
            data-done={step.done ? 'true' : undefined}
            className={cn(
              'group/step flex min-w-0 items-center gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10 transition-all hover:bg-card/80 hover:ring-foreground/20',
              step.key === nextKey && 'ring-primary/35',
            )}
          >
            {step.done ? (
              <span
                aria-hidden="true"
                className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-success/12 text-success ring-1 ring-success/20 ring-inset"
              >
                <Check className="size-[18px]" />
              </span>
            ) : (
              <IconTile icon={step.icon} tone={step.tone} size="md" />
            )}
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className={cn('text-sm font-medium', step.done ? 'text-muted-foreground' : 'text-strong')}>
                {step.title}
                {step.done && <span className="sr-only"> (done)</span>}
              </div>
              <div className="truncate text-xs text-muted-foreground">{step.description}</div>
            </div>
            {step.key === nextKey ? (
              <span className="shrink-0 rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary">
                Next
              </span>
            ) : (
              <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover/step:translate-x-0.5 group-hover/step:text-strong" />
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
