import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
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
import { WebhookAuthFields } from './webhook-auth-fields';
import { type WebhookSubscriptionFormValues } from './webhook-subscription-form';

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
          <DeliverToField
            id="webhook-deliver-to"
            value={values.deliverTo}
            onChange={(deliverTo) => {
              onChange('deliverTo', deliverTo);
              // Deliver only posts the template, so it needs a target.
              if (deliverTo === 'none') onChange('deliverOnly', false);
            }}
            error={fieldErrors.deliverTo}
          />
          <Field className="w-auto">
            <FieldLabel htmlFor="webhook-deliver-only">Deliver only</FieldLabel>
            <label className="flex items-center gap-2 text-sm has-data-disabled:text-muted-foreground" htmlFor="webhook-deliver-only">
              <Checkbox
                id="webhook-deliver-only"
                checked={values.deliverOnly}
                disabled={values.deliverTo === 'none'}
                onCheckedChange={(checked: boolean) => onChange('deliverOnly', checked)}
              />
              Skip the agent, post the template
            </label>
          </Field>
        </div>
        {values.deliverTo === 'none' && (
          <FieldDescription>The agent runs and posts no message, even when the run fails.</FieldDescription>
        )}
        {values.deliverTo === 'slack' && (
          <SlackChannelsField
            value={values.slackChannelIds}
            onChange={(ids) => onChange('slackChannelIds', ids)}
            error={fieldErrors.slackChannelIds}
          />
        )}
        {!values.deliverOnly && (
          <Field data-invalid={Boolean(fieldErrors.coalesceSeconds)}>
            <FieldLabel htmlFor="webhook-coalesce-seconds">Coalescing window (seconds)</FieldLabel>
            <Input
              id="webhook-coalesce-seconds"
              type="number"
              min={1}
              max={600}
              step={1}
              inputMode="numeric"
              aria-invalid={Boolean(fieldErrors.coalesceSeconds) || undefined}
              value={values.coalesceSeconds}
              onChange={(e) => onChange('coalesceSeconds', e.target.value)}
              placeholder="Off"
              className="w-32"
            />
            {fieldErrors.coalesceSeconds ? (
              <FieldError>{fieldErrors.coalesceSeconds}</FieldError>
            ) : (
              <FieldDescription>
                If several events arrive within this many seconds, the agent handles them in one run. Empty: one run per event.
              </FieldDescription>
            )}
          </Field>
        )}
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
