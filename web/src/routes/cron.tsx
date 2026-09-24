import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Clock, Plus, Trash2 } from 'lucide-react';
import { Page } from '@/components/layout/page';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { IconTile } from '@/components/shared/icon-tile';
import { CRON_PRESETS, describeSchedule } from '@/lib/cron-presets';
import { formatRelativeTime } from '@/lib/format';
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

  const { data: tasks, isLoading } = useQuery({
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
      <Page>
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-64" />
      </Page>
    );
  }

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

      {tasks && tasks.length > 0 ? (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Task</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead className="hidden md:table-cell">Status</TableHead>
                <TableHead className="hidden lg:table-cell">Last run</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => {
                const described = describeSchedule(t.schedule);
                return (
                  <TableRow key={t.id}>
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-3">
                        <IconTile icon={Clock} tone={t.isActive ? 'warning' : 'neutral'} />
                        <div className="min-w-0">
                          <div className="font-medium text-strong">{t.name}</div>
                          {t.instruction && (
                            <div className="max-w-md truncate text-xs text-muted-foreground">{t.instruction}</div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        {described && <span className="text-sm">{described}</span>}
                        <code className="font-mono text-xs">{t.schedule}</code>
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-sm md:table-cell">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className={cn('size-1.5 rounded-full', t.isActive ? 'bg-success' : 'bg-muted-foreground')}
                        />
                        {t.isActive ? 'Active' : 'Paused'}
                      </span>
                      {t.isActive && t.nextRunAt && (
                        <span className="block text-xs text-muted-foreground" title={new Date(t.nextRunAt).toLocaleString()}>
                          Next run {formatRelativeTime(t.nextRunAt)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                      {t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : 'Never'}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${t.name}`}
                        className="text-muted-foreground hover:text-destructive"
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          setDeleteTarget({ id: t.id, name: t.name });
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
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
        title="New cron task"
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
            <Input
              id="cron-schedule"
              aria-invalid={Boolean(fieldErrors.schedule) || undefined}
              value={form.schedule}
              onChange={(e) => setField('schedule', e.target.value)}
              placeholder="0 9 * * *"
              className="font-mono"
            />
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common schedules">
              {CRON_PRESETS.map((p) => {
                const selected = form.schedule.trim() === p.schedule;
                return (
                  <button
                    key={p.schedule}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setField('schedule', p.schedule)}
                    className={cn(
                      'rounded-full px-2.5 py-1 text-xs ring-1 transition-colors ring-inset',
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
            {fieldErrors.schedule ? (
              <FieldError>{fieldErrors.schedule}</FieldError>
            ) : (
              <FieldDescription>
                A cron expression: minute, hour, day of month, month, day of week.
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
              placeholder="What should the agent do on each tick?"
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
    </Page>
  );
}
