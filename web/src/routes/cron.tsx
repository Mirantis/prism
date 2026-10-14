import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Clock, Plus, TriangleAlert } from 'lucide-react';
import { Page } from '@/components/layout/page';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { ScheduledTaskItem } from '@/components/schedules/scheduled-task-item';
import { ScheduledTaskDialog } from '@/components/schedules/scheduled-task-dialog';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { DeleteConfirm } from '@/components/shared/delete-confirm';
import type { CronTask } from '@/types';

export const Route = createFileRoute('/cron')({
  component: CronPage,
});

function CronPage() {
  const agent = useAgent();
  const queryClient = useQueryClient();
  // The task dialog: `task` is the one being edited, and none means a new task.
  const [dialog, setDialog] = useState<{ task?: CronTask } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const { data: tasks, isLoading, isError, refetch } = useQuery({
    queryKey: ['cron-tasks', agent.agentId],
    queryFn: () => runtimeApi.listCronTasks(),
  });

  const deleteMut = useMutation({
    mutationFn: (taskId: string) => runtimeApi.deleteCronTask(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-tasks', agent.agentId] });
      setDeleteTarget(null);
    },
  });

  if (isLoading) {
    return (
      <Page>
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-64" />
      </Page>
    );
  }

  const activeCount = tasks?.filter((t) => t.isActive).length ?? 0;

  return (
    <Page>
      <PageHeader
        title="Scheduled Tasks"
        description="Recurring agent runs on a cron schedule. Each run can report back to you."
        actions={
          <Button onClick={() => setDialog({})}>
            <Plus />
            New task
          </Button>
        }
      />

      {isError ? (
        <Card>
          <EmptyState
            icon={TriangleAlert}
            title="Scheduled tasks could not be loaded"
            action={
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Try again
              </Button>
            }
          />
        </Card>
      ) : tasks && tasks.length > 0 ? (
        <Card className="gap-0 py-0" aria-label="Scheduled tasks">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
            <span>
              {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} · {activeCount} active
            </span>
          </div>
          <ul className="divide-y divide-border">
            {tasks.map((task) => (
              <ScheduledTaskItem
                key={task.id}
                task={task}
                onEdit={() => setDialog({ task })}
                onDelete={() => setDeleteTarget({ id: task.id, name: task.name })}
              />
            ))}
          </ul>
        </Card>
      ) : (
        <Card>
          <EmptyState
            icon={Clock}
            title="No scheduled tasks"
            description="Create a task to run the agent on a schedule, or ask it in chat: “every morning at 9, check my inbox”."
            action={
              <Button variant="outline" onClick={() => setDialog({})}>
                <Plus />
                New task
              </Button>
            }
          />
        </Card>
      )}

      {dialog && <ScheduledTaskDialog task={dialog.task} onClose={() => setDialog(null)} />}

      {deleteTarget && (
        <DeleteConfirm
          isOpen
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => deleteMut.mutate(deleteTarget.id)}
          isDeleting={deleteMut.isPending}
          entityType="scheduled task"
          entityName={deleteTarget.name}
        />
      )}
    </Page>
  );
}
