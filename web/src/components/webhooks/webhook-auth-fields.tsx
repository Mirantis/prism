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
 * The generic sender-verification fields of the create and edit forms.
 * Provider-agnostic by design: the operator names the header and prefix their
 * sender uses (recipes live in the docs), so no vendor is hard-coded here or in
 * the runtime.
 */
export interface WebhookAuthFormValues {
  authType: WebhookAuthType;
  authHeader: string;
  authPrefix: string;
  authAlgorithm: WebhookAuthAlgorithm;
  authEncoding: WebhookAuthEncoding;
  authSignedUrl: string;
  secret: string;
}

export const EMPTY_WEBHOOK_AUTH: WebhookAuthFormValues = {
  authType: 'token',
  authHeader: '',
  authPrefix: '',
  authAlgorithm: 'sha256',
  authEncoding: 'hex',
  authSignedUrl: '',
  secret: '',
};

export const AUTH_TYPE_LABELS: Record<WebhookAuthType, string> = {
  none: 'None',
  token: 'Shared token in a header',
  hmac: 'HMAC signature of the body',
};

/**
 * Whether the auth configuration is submittable — the same rule the runtime
 * enforces (a scheme other than 'none' needs both a header and a secret), so
 * the submit button can be disabled instead of letting the request 400.
 *
 * `hasSecret` is for the edit form: a subscription that already stores a
 * secret keeps it when the field is left empty, so the field isn't required
 * there.
 */
export function isWebhookAuthComplete(
  values: WebhookAuthFormValues,
  hasSecret = false,
): boolean {
  if (values.authType === 'none') return true;
  return Boolean(values.authHeader.trim()) && (Boolean(values.secret) || hasSecret);
}

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
        <FieldLabel htmlFor="webhook-auth-type">Scheme</FieldLabel>
        <Select
          value={authType}
          onValueChange={(value) => {
            if (value) onChange('authType', value as WebhookAuthType);
          }}
        >
          <SelectTrigger id="webhook-auth-type" className="w-full min-w-0">
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
          <FieldDescription className={authType === 'none' ? 'text-warning' : undefined}>
            {authType === 'none'
              ? 'Anyone who can reach this endpoint can send events. Choose a scheme to verify the sender.'
              : authType === 'hmac'
                ? 'Match the signature settings configured in your sender.'
                : 'Match the token header configured in your sender.'}
          </FieldDescription>
        )}
      </Field>

      {authType !== 'none' && (
        <>
          <Field data-invalid={Boolean(fieldErrors.authHeader)}>
            <FieldLabel htmlFor="webhook-auth-header">
              Header <span aria-hidden="true" className="text-muted-foreground">*</span>
            </FieldLabel>
            <Input
              id="webhook-auth-header"
              aria-required="true"
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
                The request header containing the {authType === 'hmac' ? 'signature' : 'token'}.
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
              placeholder={authType === 'hmac' ? 'sha256=' : 'Bearer'}
              className="font-mono"
            />
            {fieldErrors.authPrefix ? (
              <FieldError>{fieldErrors.authPrefix}</FieldError>
            ) : (
              <FieldDescription>
                {authType === 'hmac'
                  ? 'Text before the signature, such as sha256=. Leave empty if unused.'
                  : 'Text before the token, such as Bearer. Leave empty if unused.'}
              </FieldDescription>
            )}
          </Field>

          {authType === 'hmac' && (
            <div className="grid grid-cols-2 gap-4">
              <Field data-invalid={Boolean(fieldErrors.authAlgorithm)} className="min-w-0">
                <FieldLabel htmlFor="webhook-auth-algorithm">Algorithm</FieldLabel>
                <Select
                  value={values.authAlgorithm}
                  onValueChange={(value) => {
                    if (value) onChange('authAlgorithm', value as WebhookAuthAlgorithm);
                  }}
                >
                  <SelectTrigger id="webhook-auth-algorithm" className="w-full min-w-0">
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
              <Field data-invalid={Boolean(fieldErrors.authEncoding)} className="min-w-0">
                <FieldLabel htmlFor="webhook-auth-encoding">Encoding</FieldLabel>
                <Select
                  value={values.authEncoding}
                  onValueChange={(value) => {
                    if (value) onChange('authEncoding', value as WebhookAuthEncoding);
                  }}
                >
                  <SelectTrigger id="webhook-auth-encoding" className="w-full min-w-0">
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

          {authType === 'hmac' && (
            <Field data-invalid={Boolean(fieldErrors.authSignedUrl)}>
              <FieldLabel htmlFor="webhook-auth-signed-url">Signed URL</FieldLabel>
              <Input
                id="webhook-auth-signed-url"
                inputMode="url"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={Boolean(fieldErrors.authSignedUrl) || undefined}
                value={values.authSignedUrl}
                onChange={(e) => onChange('authSignedUrl', e.target.value)}
                placeholder="https://…/agents/webhooks/name"
                className="font-mono"
              />
              {fieldErrors.authSignedUrl ? (
                <FieldError>{fieldErrors.authSignedUrl}</FieldError>
              ) : (
                <FieldDescription>
                  For a sender that signs the body followed by the endpoint URL: enter the exact URL
                  configured in the sender. Leave empty if it signs the body alone.
                </FieldDescription>
              )}
            </Field>
          )}

          <Field data-invalid={Boolean(fieldErrors.secret)}>
            <FieldLabel htmlFor="webhook-secret">
              Secret {!hasSecret && <span aria-hidden="true" className="text-muted-foreground">*</span>}
            </FieldLabel>
            <Input
              id="webhook-secret"
              type="password"
              autoComplete="off"
              aria-required={!hasSecret || undefined}
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
                  ? 'Leave empty to keep the stored secret, or enter a new one to replace it.'
                  : 'Use the same secret in your sender and this subscription.'}
              </FieldDescription>
            )}
          </Field>
        </>
      )}
    </>
  );
}
