import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import { DeliverToField } from '@/components/shared/deliver-to-field';
import { SlackChannelsField } from '@/components/shared/slack-channels-field';
import { CRON_PRESETS, describeSchedule, normalizeSchedule } from '@/lib/cron-presets';
import { cn } from '@/lib/utils';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import type { CronTaskInput } from '@/types';

interface ScheduledTaskFieldsProps {
  values: CronTaskInput;
  onChange: <K extends keyof CronTaskInput>(key: K, value: CronTaskInput[K]) => void;
  fieldErrors: Record<string, string>;
  /** The time a one-off task runs, while the form still holds its schedule. */
  runsOnceAt?: string | null;
  /** True for a task that continues a conversation: it only runs once, and it answers there. */
  continuesConversation?: boolean;
}

/** Name, schedule, instruction and delivery of a scheduled task, as the task dialog asks for them. */
export function ScheduledTaskFields({
  values,
  onChange,
  fieldErrors,
  runsOnceAt,
  continuesConversation = false,
}: ScheduledTaskFieldsProps) {
  const agent = useAgent();

  // Every schedule is read in the agent's time zone, so the form says which one that is.
  const { data: details } = useQuery({
    queryKey: ['agent-details', agent.agentId],
    queryFn: () => runtimeApi.details(),
  });
  const zoneWords = details ? `the agent's time zone, ${details.timezone}` : "the agent's time zone";
  const described = describeSchedule(values.schedule);
  const scheduleHelp = runsOnceAt
    ? `Runs once, at ${new Date(runsOnceAt).toLocaleString()}.${continuesConversation ? '' : ' Enter a cron expression to repeat it instead.'}`
    : described
      ? `${described} in ${zoneWords}. Edit the expression for another time.`
      : `A cron expression: minute, hour, day of month, month, day of week, read in ${zoneWords}.`;

  return (
    <FieldGroup>
      <Field data-invalid={Boolean(fieldErrors.name)}>
        <FieldLabel htmlFor="cron-name">Name</FieldLabel>
        <Input
          id="cron-name"
          aria-invalid={Boolean(fieldErrors.name) || undefined}
          value={values.name}
          onChange={(e) => onChange('name', e.target.value)}
          placeholder="Daily standup summary"
        />
        {fieldErrors.name && <FieldError>{fieldErrors.name}</FieldError>}
      </Field>
      <Field data-invalid={Boolean(fieldErrors.schedule)}>
        <FieldLabel htmlFor="cron-schedule">Schedule</FieldLabel>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common schedules">
          {CRON_PRESETS.map((p) => {
            const selected = normalizeSchedule(values.schedule) === p.schedule;
            return (
              <button
                key={p.schedule}
                type="button"
                aria-pressed={selected}
                onClick={() => onChange('schedule', p.schedule)}
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
          value={values.schedule}
          onChange={(e) => onChange('schedule', e.target.value)}
          placeholder="0 9 * * *"
          className="font-mono"
        />
        {fieldErrors.schedule ? (
          <FieldError>{fieldErrors.schedule}</FieldError>
        ) : (
          <FieldDescription data-testid="schedule-help">{scheduleHelp}</FieldDescription>
        )}
      </Field>
      <Field data-invalid={Boolean(fieldErrors.instruction)}>
        <FieldLabel htmlFor="cron-instruction">Instruction</FieldLabel>
        <Textarea
          id="cron-instruction"
          aria-invalid={Boolean(fieldErrors.instruction) || undefined}
          value={values.instruction}
          onChange={(e) => onChange('instruction', e.target.value)}
          placeholder="What should the agent do each time?"
          rows={3}
        />
        {fieldErrors.instruction && <FieldError>{fieldErrors.instruction}</FieldError>}
      </Field>
      {continuesConversation ? (
        <FieldDescription>The task replies in the conversation that scheduled it.</FieldDescription>
      ) : (
        <>
          <FieldSeparator />
          <FieldSet>
            <FieldLegend>Delivery</FieldLegend>
            <DeliverToField
              id="cron-deliver-to"
              value={values.deliverTo}
              onChange={(deliverTo) => onChange('deliverTo', deliverTo)}
              error={fieldErrors.deliverTo}
            />
            {values.deliverTo === 'none' && (
              <FieldDescription>The task runs and posts no message, even when the run fails.</FieldDescription>
            )}
            {values.deliverTo === 'slack' && (
              <SlackChannelsField
                value={values.channelIds}
                onChange={(ids) => onChange('channelIds', ids)}
                error={fieldErrors.channelIds}
              />
            )}
          </FieldSet>
        </>
      )}
    </FieldGroup>
  );
}
