import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Clock, Plus } from 'lucide-react';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { useFormErrors } from '@/hooks/use-form-errors';
import { CreateModal } from '@/components/shared/create-modal';
import { SchedulePresets } from '@/components/schedules/schedule-presets';
import { ScheduledTaskItem } from '@/components/schedules/scheduled-task-item';
import { scheduleDescription } from '@/lib/schedule';
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

  const {
    data: tasks,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['cron-tasks', agent.agentId],
    queryFn: () => runtimeApi.listCronTasks(),
  });

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
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 mt-6" />
      </div>
    );
  }

  return (
    <div className="page-content space-y-8">
      <PageHeader
        title="Scheduled Tasks"
        description="Put recurring work on autopilot with scheduled agent runs."
        actions={
          <Button onClick={() => setIsCreating(true)}>
            <Plus className="size-4" />
            New task
          </Button>
        }
      />

      {isError ? (
        <Card>
          <CardContent className="space-y-3">
            <p>Scheduled tasks could not be loaded.</p>
            <Button variant="outline" onClick={() => refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : tasks && tasks.length > 0 ? (
        <section
          className="overflow-hidden rounded-2xl border border-border bg-card"
          aria-label="Scheduled tasks"
        >
          <div className="border-b border-border px-5 py-4 text-sm text-muted-foreground sm:px-6">
            {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} ·{' '}
            {tasks.filter((task) => task.isActive).length} active
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
        </section>
      ) : (
        <Card>
          <CardContent>
            <EmptyState
              icon={Clock}
              title="No scheduled tasks"
              description="Let your agent take care of recurring work. Create a task to get started."
              action={
                <Button variant="outline" onClick={() => setIsCreating(true)}>
                  <Plus className="size-4" />
                  Create your first task
                </Button>
              }
            />
          </CardContent>
        </Card>
      )}

      <CreateModal
        isOpen={isCreating}
        onClose={resetModal}
        title="New scheduled task"
        onSubmit={handleCreate}
        isSubmitting={scheduleMut.isPending}
        submitLabel="Schedule"
        submitDisabled={!form.name.trim() || !form.schedule.trim()}
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
            <SchedulePresets
              value={form.schedule}
              onChange={(value) => setField('schedule', value)}
            />
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
              <FieldDescription>
                {scheduleDescription(form.schedule) ?? 'Custom cron schedule'}. Edit the expression
                to choose another time.
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
              placeholder="What should your agent do each time?"
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
          entityType="cron task"
          entityName={deleteTarget.name}
        />
      )}
    </div>
  );
}
