import { Clock, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { scheduleDescription } from '@/lib/schedule';
import type { CronTask } from '@/types';

export function ScheduledTaskItem({ task, onDelete }: { task: CronTask; onDelete: () => void }) {
  const description = scheduleDescription(task.schedule);
  return (
    <li className="flex gap-4 p-5 sm:p-6">
      <div className="hidden size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-background sm:flex">
        <Clock className="size-5 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="break-words text-base font-semibold">{task.name}</h2>
          <Badge variant="secondary" className="gap-1.5 text-[10px]">
            <span
              className={`size-1.5 rounded-full ${task.isActive ? 'bg-primary' : 'bg-muted-foreground'}`}
            />
            {task.isActive ? 'Active' : 'Inactive'}
          </Badge>
        </div>
        {task.instruction && (
          <p className="mt-2 max-w-3xl whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
            {task.instruction}
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          {description && <span className="font-medium">{description}</span>}
          <code className="rounded-md border border-border bg-background px-2 py-1 text-muted-foreground">
            {task.schedule}
          </code>
          <span className="text-muted-foreground">
            {task.lastRunAt
              ? `Last run ${new Date(task.lastRunAt).toLocaleString()}`
              : 'Has not run yet'}
          </span>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={`Delete ${task.name}`}
        onClick={onDelete}
      >
        <Trash2 className="size-4" />
      </Button>
    </li>
  );
}
