import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import type { WebhookAuthAlgorithm, WebhookAuthEncoding, WebhookAuthType } from '@/types';

/**
 * The generic sender-verification fields, shared by the create modal and the
 * per-row rotate dialog. Provider-agnostic by design: the operator names the
 * header and prefix their sender uses (recipes live in the docs), so no
 * vendor is hard-coded here or in the runtime.
 */
export interface WebhookAuthFormValues {
  authType: WebhookAuthType;
  authHeader: string;
  authPrefix: string;
  authAlgorithm: WebhookAuthAlgorithm;
  authEncoding: WebhookAuthEncoding;
  secret: string;
}

export const EMPTY_WEBHOOK_AUTH: WebhookAuthFormValues = {
  authType: 'none',
  authHeader: '',
  authPrefix: '',
  authAlgorithm: 'sha256',
  authEncoding: 'hex',
  secret: '',
};

export const AUTH_TYPE_LABELS: Record<WebhookAuthType, string> = {
  none: 'None',
  token: 'Shared token in a header',
  hmac: 'HMAC signature of the body',
};

interface WebhookAuthFieldsProps {
  values: WebhookAuthFormValues;
  onChange: <K extends keyof WebhookAuthFormValues>(
    key: K,
    value: WebhookAuthFormValues[K],
  ) => void;
  fieldErrors: Record<string, string>;
  /** True when a secret is already stored — then leaving Secret blank keeps it. */
  hasSecret?: boolean;
}

export function WebhookAuthFields({
  values,
  onChange,
  fieldErrors,
  hasSecret = false,
}: WebhookAuthFieldsProps) {
  const { authType } = values;

  return (
    <>
      <Field data-invalid={Boolean(fieldErrors.authType)}>
        {/* "Scheme", not "Authentication" — the surrounding section is already
            titled Authentication (create modal) or names it (rotate dialog). */}
        <FieldLabel htmlFor="webhook-auth-type">Scheme</FieldLabel>
        <Select
          value={authType}
          onValueChange={(value) => {
            if (value) onChange('authType', value as WebhookAuthType);
          }}
        >
          <SelectTrigger id="webhook-auth-type" className="min-w-56">
            <SelectValue>{AUTH_TYPE_LABELS[authType]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{AUTH_TYPE_LABELS.none}</SelectItem>
            <SelectItem value="token">{AUTH_TYPE_LABELS.token}</SelectItem>
            <SelectItem value="hmac">{AUTH_TYPE_LABELS.hmac}</SelectItem>
          </SelectContent>
        </Select>
        {fieldErrors.authType ? (
          <FieldError>{fieldErrors.authType}</FieldError>
        ) : (
          <FieldDescription>
            Verify that events really come from your sender. Without it, anyone who can reach this
            endpoint can trigger the agent.
          </FieldDescription>
        )}
      </Field>

      {authType !== 'none' && (
        <>
          <Field data-invalid={Boolean(fieldErrors.authHeader)}>
            <FieldLabel htmlFor="webhook-auth-header">Header</FieldLabel>
            <Input
              id="webhook-auth-header"
              aria-invalid={Boolean(fieldErrors.authHeader) || undefined}
              value={values.authHeader}
              onChange={(e) => onChange('authHeader', e.target.value)}
              placeholder={authType === 'hmac' ? 'X-Hub-Signature-256' : 'Authorization'}
              className="font-mono"
            />
            {fieldErrors.authHeader ? (
              <FieldError>{fieldErrors.authHeader}</FieldError>
            ) : (
              <FieldDescription>
                The request header carrying the {authType === 'hmac' ? 'signature' : 'token'}.
              </FieldDescription>
            )}
          </Field>

          <Field data-invalid={Boolean(fieldErrors.authPrefix)}>
            <FieldLabel htmlFor="webhook-auth-prefix">Prefix</FieldLabel>
            <Input
              id="webhook-auth-prefix"
              aria-invalid={Boolean(fieldErrors.authPrefix) || undefined}
              value={values.authPrefix}
              onChange={(e) => onChange('authPrefix', e.target.value)}
              placeholder={authType === 'hmac' ? 'sha256=' : 'Bearer '}
              className="font-mono"
            />
            {fieldErrors.authPrefix ? (
              <FieldError>{fieldErrors.authPrefix}</FieldError>
            ) : (
              <FieldDescription>
                Optional literal in front of the value, e.g. <code>sha256=</code>, <code>v1=</code>{' '}
                or <code>Bearer </code> (trailing space included). Leave empty for a bare value.
              </FieldDescription>
            )}
          </Field>

          {authType === 'hmac' && (
            <div className="flex flex-wrap items-start gap-6">
              <Field data-invalid={Boolean(fieldErrors.authAlgorithm)} className="w-auto">
                <FieldLabel htmlFor="webhook-auth-algorithm">Algorithm</FieldLabel>
                <Select
                  value={values.authAlgorithm}
                  onValueChange={(value) => {
                    if (value) onChange('authAlgorithm', value as WebhookAuthAlgorithm);
                  }}
                >
                  <SelectTrigger id="webhook-auth-algorithm" className="min-w-32">
                    <SelectValue>{values.authAlgorithm}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sha256">sha256</SelectItem>
                    <SelectItem value="sha1">sha1</SelectItem>
                    <SelectItem value="sha512">sha512</SelectItem>
                  </SelectContent>
                </Select>
                {fieldErrors.authAlgorithm && <FieldError>{fieldErrors.authAlgorithm}</FieldError>}
              </Field>
              <Field data-invalid={Boolean(fieldErrors.authEncoding)} className="w-auto">
                <FieldLabel htmlFor="webhook-auth-encoding">Encoding</FieldLabel>
                <Select
                  value={values.authEncoding}
                  onValueChange={(value) => {
                    if (value) onChange('authEncoding', value as WebhookAuthEncoding);
                  }}
                >
                  <SelectTrigger id="webhook-auth-encoding" className="min-w-32">
                    <SelectValue>{values.authEncoding}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hex">hex</SelectItem>
                    <SelectItem value="base64">base64</SelectItem>
                  </SelectContent>
                </Select>
                {fieldErrors.authEncoding && <FieldError>{fieldErrors.authEncoding}</FieldError>}
              </Field>
            </div>
          )}

          <Field data-invalid={Boolean(fieldErrors.secret)}>
            <FieldLabel htmlFor="webhook-secret">Secret</FieldLabel>
            <Input
              id="webhook-secret"
              type="password"
              autoComplete="off"
              aria-invalid={Boolean(fieldErrors.secret) || undefined}
              value={values.secret}
              onChange={(e) => onChange('secret', e.target.value)}
              placeholder={hasSecret ? 'Leave empty to keep the current secret' : 'Paste the sender’s secret'}
              className="font-mono"
            />
            {fieldErrors.secret ? (
              <FieldError>{fieldErrors.secret}</FieldError>
            ) : (
              <FieldDescription>
                {hasSecret
                  ? 'A secret is stored. Enter a new one to replace it; it is never displayed again.'
                  : 'Shared with the sender only. Stored on this agent and never shown again.'}
              </FieldDescription>
            )}
          </Field>
        </>
      )}
    </>
  );
}
