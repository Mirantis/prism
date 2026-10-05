import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import type { WebhookDeliverTo } from '@/types';
import { WebhookAuthFields } from './webhook-auth-fields';
import { DELIVER_LABELS, type WebhookSubscriptionFormValues } from './webhook-subscription-form';

interface WebhookSubscriptionFieldsProps {
  /** `create` adds the Name field; the name is the endpoint path, so edit has none. */
  mode: 'create' | 'edit';
  values: WebhookSubscriptionFormValues;
  onChange: <K extends keyof WebhookSubscriptionFormValues>(
    key: K,
    value: WebhookSubscriptionFormValues[K],
  ) => void;
  fieldErrors: Record<string, string>;
  /** True when a secret is already stored — then leaving Secret blank keeps it. */
  hasSecret?: boolean;
}

/** The subscription form body, shared by the create and edit dialogs. */
export function WebhookSubscriptionFields({
  mode,
  values,
  onChange,
  fieldErrors,
  hasSecret = false,
}: WebhookSubscriptionFieldsProps) {
  return (
    <FieldGroup>
      {/* No legend on the first group: the name/description/events fields
          are self-evident, and a heading above them would just repeat the
          dialog title. */}
      <FieldSet>
        {mode === 'create' && (
          <Field data-invalid={Boolean(fieldErrors.name)}>
            <FieldLabel htmlFor="webhook-name">
              Name <span aria-hidden="true" className="text-muted-foreground">*</span>
            </FieldLabel>
            <Input
              id="webhook-name"
              aria-required="true"
              aria-invalid={Boolean(fieldErrors.name) || undefined}
              value={values.name}
              onChange={(e) => onChange('name', e.target.value)}
              placeholder="e.g. github-push"
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
            />
            {fieldErrors.name ? (
              <FieldError>{fieldErrors.name}</FieldError>
            ) : (
              <FieldDescription>
                Use lowercase letters, numbers, hyphens, or underscores. This becomes the endpoint name.
              </FieldDescription>
            )}
          </Field>
        )}
        <Field data-invalid={Boolean(fieldErrors.description)}>
          <FieldLabel htmlFor="webhook-description">Description</FieldLabel>
          <Input
            id="webhook-description"
            value={values.description}
            onChange={(e) => onChange('description', e.target.value)}
            placeholder="What this webhook does (optional)"
          />
          {fieldErrors.description && <FieldError>{fieldErrors.description}</FieldError>}
        </Field>
        <Field data-invalid={Boolean(fieldErrors.events)}>
          <FieldLabel htmlFor="webhook-events">Events</FieldLabel>
          <Input
            id="webhook-events"
            value={values.events}
            onChange={(e) => onChange('events', e.target.value)}
            placeholder="comma-separated, leave empty for all"
            className="font-mono"
          />
          {fieldErrors.events ? (
            <FieldError>{fieldErrors.events}</FieldError>
          ) : (
            <FieldDescription>
              Matched against GitHub/GitLab event headers. Leave empty for sources like
              Alertmanager or PagerDuty.
            </FieldDescription>
          )}
        </Field>
      </FieldSet>

      <FieldSeparator />

      <FieldSet>
        <FieldLegend>Delivery</FieldLegend>
        <div className="flex flex-wrap items-start gap-6">
          <Field data-invalid={Boolean(fieldErrors.deliverTo)} className="w-auto">
            <FieldLabel htmlFor="webhook-deliver-to">Deliver to</FieldLabel>
            <Select
              value={values.deliverTo}
              onValueChange={(value) => {
                if (value) onChange('deliverTo', value as WebhookDeliverTo);
              }}
            >
              <SelectTrigger id="webhook-deliver-to" className="min-w-40">
                <SelectValue>{DELIVER_LABELS[values.deliverTo]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{DELIVER_LABELS.all}</SelectItem>
                <SelectItem value="chat">{DELIVER_LABELS.chat}</SelectItem>
                <SelectItem value="slack">{DELIVER_LABELS.slack}</SelectItem>
                <SelectItem value="teams">{DELIVER_LABELS.teams}</SelectItem>
              </SelectContent>
            </Select>
            {fieldErrors.deliverTo && <FieldError>{fieldErrors.deliverTo}</FieldError>}
          </Field>
          <Field className="w-auto">
            <FieldLabel htmlFor="webhook-deliver-only">Deliver only</FieldLabel>
            <label className="flex items-center gap-2 text-sm" htmlFor="webhook-deliver-only">
              <Checkbox
                id="webhook-deliver-only"
                checked={values.deliverOnly}
                onCheckedChange={(checked: boolean) => onChange('deliverOnly', checked)}
              />
              Skip the agent, deliver payload directly
            </label>
          </Field>
        </div>
        <Field data-invalid={Boolean(fieldErrors.prompt)}>
          <FieldLabel htmlFor="webhook-prompt">{values.deliverOnly ? 'Message template' : 'Prompt'}</FieldLabel>
          <Textarea
            id="webhook-prompt"
            value={values.prompt}
            onChange={(e) => onChange('prompt', e.target.value)}
            placeholder={values.deliverOnly ? 'Message to deliver, e.g. Alert: {status}' : 'Instructions for the agent when this webhook fires (optional)'}
            rows={3}
          />
          {fieldErrors.prompt ? (
            <FieldError>{fieldErrors.prompt}</FieldError>
          ) : (
            <FieldDescription>
              Supports <code>{'{field.path}'}</code> payload substitution and{' '}
              <code>{'{__raw__}'}</code> for the full payload. Empty = raw payload dump.
            </FieldDescription>
          )}
        </Field>
      </FieldSet>

      <FieldSeparator />

      <FieldSet>
        <FieldLegend>Authentication</FieldLegend>
        <WebhookAuthFields
          values={values}
          // Each auth key has the same value type in both forms; TypeScript
          // cannot relate the two indexed types through a generic key.
          onChange={(key, value) => onChange(key, value as WebhookSubscriptionFormValues[typeof key])}
          fieldErrors={fieldErrors}
          hasSecret={hasSecret}
        />
      </FieldSet>
    </FieldGroup>
  );
}
