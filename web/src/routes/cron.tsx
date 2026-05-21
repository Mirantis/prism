import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
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
    queryFn: () => runtimeApi.listCronTasks(agent.agentId),
  });

  const scheduleMut = useMutation({
    mutationFn: (input: { name: string; schedule: string; instruction: string }) =>
      runtimeApi.createCronTask(agent.agentId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-tasks', agent.agentId] });
      resetModal();
    },
  });

  const deleteMut = useMutation({
    mutationFn: (taskId: string) => runtimeApi.deleteCronTask(agent.agentId, taskId),
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Scheduled Tasks</h2>
          <p className="text-sm text-muted-foreground">Recurring agent runs scheduled via cron expressions.</p>
        </div>
        <Button onClick={() => setIsCreating(true)}>
          <Plus className="mr-1 h-4 w-4" />
          New task
        </Button>
      </div>

      {tasks && tasks.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead className="hidden md:table-cell">Last run</TableHead>
                  <TableHead className="w-[50px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="flex size-8 items-center justify-center rounded-md bg-muted">
                          <Clock className="size-4 text-muted-foreground" />
                        </div>
                        <span className="font-medium">{t.name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {t.schedule}
                      </code>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                      {t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          setDeleteTarget({ id: t.id, name: t.name });
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent>
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Clock className="h-10 w-10 mb-2 opacity-50" />
              <p className="text-sm">No scheduled tasks</p>
              <p className="text-xs">Create a cron task to run the agent on a schedule.</p>
            </div>
          </CardContent>
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
          <Field data-invalid={!!fieldErrors.name}>
            <FieldLabel htmlFor="cron-name">Name</FieldLabel>
            <Input
              id="cron-name"
              aria-invalid={!!fieldErrors.name || undefined}
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder="Daily standup summary"
            />
            {fieldErrors.name && <FieldError>{fieldErrors.name}</FieldError>}
          </Field>
          <Field data-invalid={!!fieldErrors.schedule}>
            <FieldLabel htmlFor="cron-schedule">Schedule</FieldLabel>
            <Input
              id="cron-schedule"
              aria-invalid={!!fieldErrors.schedule || undefined}
              value={form.schedule}
              onChange={(e) => setField('schedule', e.target.value)}
              placeholder="0 9 * * *"
              className="font-mono"
            />
            {fieldErrors.schedule ? (
              <FieldError>{fieldErrors.schedule}</FieldError>
            ) : (
              <FieldDescription>
                Example: <code>0 9 * * *</code> = every day at 09:00.
              </FieldDescription>
            )}
          </Field>
          <Field data-invalid={!!fieldErrors.instruction}>
            <FieldLabel htmlFor="cron-instruction">Instruction</FieldLabel>
            <Textarea
              id="cron-instruction"
              aria-invalid={!!fieldErrors.instruction || undefined}
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
    </div>
  );
}
