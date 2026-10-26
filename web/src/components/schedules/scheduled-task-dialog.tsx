import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreateModal } from '@/components/shared/create-modal';
import { ScheduledTaskFields } from '@/components/schedules/scheduled-task-fields';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { useFormErrors } from '@/hooks/use-form-errors';
import type { CronTask, CronTaskInput } from '@/types';

interface ScheduledTaskDialogProps {
  /** The task to edit. Without one, the dialog creates a task. */
  task?: CronTask;
  onClose: () => void;
}

const TEXT_FIELDS = ['name', 'schedule', 'instruction'] as const;

/** Create a scheduled task, or edit the name, schedule, instruction and delivery of one. */
export function ScheduledTaskDialog({ task, onClose }: ScheduledTaskDialogProps) {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const { fieldErrors, clearFieldError, handleError } = useFormErrors();
  const [values, setValues] = useState<CronTaskInput>({
    name: task?.name ?? '',
    schedule: task?.schedule ?? '0 9 * * *',
    instruction: task?.instruction ?? '',
    deliverTo: task?.deliverTo ?? 'all',
    channelIds: task?.channelIds ?? [],
  });
  const input: CronTaskInput = {
    name: values.name.trim(),
    schedule: values.schedule.trim(),
    instruction: values.instruction.trim(),
    deliverTo: values.deliverTo,
    // The runtime takes a channel list for the Slack target only; the form keeps it while another is picked.
    channelIds: values.deliverTo === 'slack' ? values.channelIds : [],
  };

  const setField = <K extends keyof CronTaskInput>(key: K, value: CronTaskInput[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    clearFieldError(key);
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!task) {
        await runtimeApi.createCronTask(input);
        return;
      }
      // An edit sends only the fields that changed: a schedule that is sent is read again from now.
      const changes: Partial<CronTaskInput> = {};
      for (const key of TEXT_FIELDS) {
        if (input[key] !== (task[key] ?? '').trim()) changes[key] = input[key];
      }
      if (input.deliverTo !== task.deliverTo) changes.deliverTo = input.deliverTo;
      if (input.channelIds.join(',') !== task.channelIds.join(',')) changes.channelIds = input.channelIds;
      if (Object.keys(changes).length > 0) await runtimeApi.updateCronTask(task.id, changes);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-tasks', agent.agentId] });
      onClose();
    },
  });

  const keepsRunTime = task && !task.recurring && input.schedule === task.schedule.trim();

  return (
    <CreateModal
      isOpen
      onClose={onClose}
      title={task ? `Edit ${task.name}` : 'New scheduled task'}
      onSubmit={async () => {
        try {
          await saveMut.mutateAsync();
        } catch (e) {
          handleError(e);
        }
      }}
      isSubmitting={saveMut.isPending}
      submitLabel={task ? 'Save' : 'Schedule'}
      submitDisabled={!input.name || !input.schedule || !input.instruction}
    >
      <ScheduledTaskFields
        values={values}
        onChange={setField}
        fieldErrors={fieldErrors}
        runsOnceAt={keepsRunTime ? task.nextRunAt : null}
        continuesConversation={Boolean(task?.threadId)}
      />
    </CreateModal>
  );
}
