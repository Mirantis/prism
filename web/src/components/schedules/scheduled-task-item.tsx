import { Clock, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconTile } from '@/components/shared/icon-tile';
import { describeSchedule } from '@/lib/cron-presets';
import { DELIVER_LABELS, slackChannelNames } from '@/lib/delivery-labels';
import { useSlackChannels } from '@/hooks/use-slack-channels';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CronTask } from '@/types';

/** One scheduled task: what it does, when it runs, and whether it is running at all. */
export function ScheduledTaskItem({
  task,
  onEdit,
  onDelete,
}: {
  task: CronTask;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const described = describeSchedule(task.schedule);
  const { data: slackChannels } = useSlackChannels();
  // Every connected channel is the usual target, so the row names only another one.
  const delivery =
    task.threadId || task.deliverTo === 'all'
      ? null
      : [DELIVER_LABELS[task.deliverTo], slackChannelNames(task.channelIds, slackChannels?.channels ?? [])]
          .filter(Boolean)
          .join(': ');
  return (
    <li
      data-testid="scheduled-task"
      className="group/task flex gap-4 px-4 py-4 transition-colors hover:bg-accent/40 sm:px-5"
    >
      <IconTile icon={Clock} tone={task.isActive ? 'warning' : 'neutral'} size="md" className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h3 className="text-sm font-medium text-strong">{task.name}</h3>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              aria-hidden="true"
              className={cn('size-1.5 rounded-full', task.isActive ? 'bg-success' : 'bg-muted-foreground')}
            />
            {task.isActive ? 'Active' : 'Paused'}
          </span>
        </div>
        {task.instruction && (
          <p className="line-clamp-2 text-sm text-muted-foreground text-pretty">{task.instruction}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-xs text-muted-foreground">
          {described && <span className="text-foreground">{described}</span>}
          <code className="rounded-md bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            {task.schedule}
          </code>
          {task.isActive && task.nextRunAt && (
            <span title={new Date(task.nextRunAt).toLocaleString()}>Next run {formatRelativeTime(task.nextRunAt)}</span>
          )}
          <span title={task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : undefined}>
            {task.lastRunAt ? `Last run ${formatRelativeTime(task.lastRunAt)}` : 'Not run yet'}
          </span>
          {delivery && (
            <span data-testid="scheduled-task-delivery">
              {task.deliverTo === 'none' ? 'Delivers nowhere' : `Delivers to ${delivery}`}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-start gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          title="Edit"
          aria-label={`Edit ${task.name}`}
          className="text-muted-foreground"
          onClick={onEdit}
        >
          <Pencil className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${task.name}`}
          className="text-muted-foreground hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </li>
  );
}
