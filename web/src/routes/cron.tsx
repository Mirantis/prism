import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Clock, Plus, TriangleAlert } from 'lucide-react';
import { Page } from '@/components/layout/page';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { ScheduledTaskItem } from '@/components/schedules/scheduled-task-item';
import { CRON_PRESETS, describeSchedule, normalizeSchedule } from '@/lib/cron-presets';
import { cn } from '@/lib/utils';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { useFormErrors } from '@/hooks/use-form-errors';
import { CreateModal } from '@/components/shared/create-modal';
import { DeleteConfirm } from '@/components/shared/delete-confirm';

export const Route = createFileRoute('/cron')({
  component: CronPage,
});

function CronPage() {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [form, setForm] = useState({ name: '', schedule: '0 9 * * *', instruction: '' });
  const { fieldErrors, clearFieldError, handleError, reset: resetErrors } = useFormErrors();

  const { data: tasks, isLoading, isError, refetch } = useQuery({
    queryKey: ['cron-tasks', agent.agentId],
    queryFn: () => runtimeApi.listCronTasks(),
  });

  // Every schedule is read in the agent's time zone, so the form says which one that is.
  const { data: details } = useQuery({
    queryKey: ['agent-details', agent.agentId],
    queryFn: () => runtimeApi.details(),
  });
  const zoneWords = details ? `the agent's time zone, ${details.timezone}` : "the agent's time zone";

  const scheduleMut = useMutation({
    mutationFn: (input: { name: string; schedule: string; instruction: string }) =>
      runtimeApi.createCronTask(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-tasks', agent.agentId] });
      resetModal();
    },
  });

  const deleteMut = useMutation({
    mutationFn: (taskId: string) => runtimeApi.deleteCronTask(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-tasks', agent.agentId] });
      setDeleteTarget(null);
    },
  });

  const setField = (key: 'name' | 'schedule' | 'instruction', value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    clearFieldError(key);
  };

  const resetModal = () => {
    setIsCreating(false);
    setForm({ name: '', schedule: '0 9 * * *', instruction: '' });
    resetErrors();
  };

  const handleCreate = async () => {
    try {
      await scheduleMut.mutateAsync({
        name: form.name.trim(),
        schedule: form.schedule.trim(),
        instruction: form.instruction.trim(),
      });
    } catch (e) {
      handleError(e);
    }
  };

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
  const describedForm = describeSchedule(form.schedule);

  return (
    <Page>
      <PageHeader
        title="Scheduled Tasks"
        description="Recurring agent runs on a cron schedule. Each run can report back to you."
        actions={
          <Button onClick={() => setIsCreating(true)}>
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
              <Button variant="outline" onClick={() => setIsCreating(true)}>
                <Plus />
                New task
              </Button>
            }
          />
        </Card>
      )}

      <CreateModal
        isOpen={isCreating}
        onClose={resetModal}
        title="New scheduled task"
        onSubmit={handleCreate}
        isSubmitting={scheduleMut.isPending}
        submitLabel="Schedule"
        submitDisabled={!form.name.trim() || !form.schedule.trim() || !form.instruction.trim()}
      >
        <FieldGroup>
          <Field data-invalid={Boolean(fieldErrors.name)}>
            <FieldLabel htmlFor="cron-name">Name</FieldLabel>
            <Input
              id="cron-name"
              aria-invalid={Boolean(fieldErrors.name) || undefined}
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder="Daily standup summary"
            />
            {fieldErrors.name && <FieldError>{fieldErrors.name}</FieldError>}
          </Field>
          <Field data-invalid={Boolean(fieldErrors.schedule)}>
            <FieldLabel htmlFor="cron-schedule">Schedule</FieldLabel>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common schedules">
              {CRON_PRESETS.map((p) => {
                const selected = normalizeSchedule(form.schedule) === p.schedule;
                return (
                  <button
                    key={p.schedule}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setField('schedule', p.schedule)}
                    className={cn(
                      'rounded-full px-2.5 py-1 text-xs ring-1 transition-colors ring-inset outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected
                        ? 'bg-primary/15 text-strong ring-primary/40'
                        : 'text-muted-foreground ring-border hover:bg-muted/50 hover:text-strong',
                    )}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <Input
              id="cron-schedule"
              aria-invalid={Boolean(fieldErrors.schedule) || undefined}
              value={form.schedule}
              onChange={(e) => setField('schedule', e.target.value)}
              placeholder="0 9 * * *"
              className="font-mono"
            />
            {fieldErrors.schedule ? (
              <FieldError>{fieldErrors.schedule}</FieldError>
            ) : (
              <FieldDescription data-testid="schedule-help">
                {describedForm
                  ? `${describedForm} in ${zoneWords}. Edit the expression for another time.`
                  : `A cron expression: minute, hour, day of month, month, day of week, read in ${zoneWords}.`}
              </FieldDescription>
            )}
          </Field>
          <Field data-invalid={Boolean(fieldErrors.instruction)}>
            <FieldLabel htmlFor="cron-instruction">Instruction</FieldLabel>
            <Textarea
              id="cron-instruction"
              aria-invalid={Boolean(fieldErrors.instruction) || undefined}
              value={form.instruction}
              onChange={(e) => setField('instruction', e.target.value)}
              placeholder="What should the agent do each time?"
              rows={3}
            />
            {fieldErrors.instruction && <FieldError>{fieldErrors.instruction}</FieldError>}
          </Field>
        </FieldGroup>
      </CreateModal>

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
