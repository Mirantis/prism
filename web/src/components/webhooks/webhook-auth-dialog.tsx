import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FieldGroup } from '@/components/ui/field';
import { CreateModal } from '@/components/shared/create-modal';
import { runtimeApi } from '@/api/runtime-client';
import { useFormErrors } from '@/hooks/use-form-errors';
import {
  EMPTY_WEBHOOK_AUTH,
  WebhookAuthFields,
  type WebhookAuthFormValues,
} from './webhook-auth-fields';
import type { WebhookSubscription } from '@/types';

interface WebhookAuthDialogProps {
  subscription: WebhookSubscription;
  onClose: () => void;
}

/**
 * Change a subscription's sender verification — including rotating the secret —
 * without losing its endpoint name. The current secret is never sent to the
 * browser, so an empty Secret field means "keep what's stored".
 */
export function WebhookAuthDialog({ subscription, onClose }: WebhookAuthDialogProps) {
  const queryClient = useQueryClient();
  const { fieldErrors, clearFieldError, handleError, reset: resetErrors } = useFormErrors();
  const [values, setValues] = useState<WebhookAuthFormValues>({
    ...EMPTY_WEBHOOK_AUTH,
    authType: subscription.authType,
    authHeader: subscription.authHeader ?? '',
    authPrefix: subscription.authPrefix ?? '',
    authAlgorithm: subscription.authAlgorithm,
    authEncoding: subscription.authEncoding,
  });

  const setField = <K extends keyof WebhookAuthFormValues>(
    key: K,
    value: WebhookAuthFormValues[K],
  ) => {
    setValues((v) => ({ ...v, [key]: value }));
    clearFieldError(key);
  };

  const saveMut = useMutation({
    mutationFn: () =>
      runtimeApi.updateWebhookSubscription(subscription.id, {
        authType: values.authType,
        authHeader: values.authHeader.trim() || null,
        authPrefix: values.authPrefix || null,
        authAlgorithm: values.authAlgorithm,
        authEncoding: values.authEncoding,
        // Omitted when blank so the stored secret survives an unrelated edit.
        ...(values.secret ? { secret: values.secret } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhook-subscriptions', subscription.agentId] });
      resetErrors();
      onClose();
    },
  });

  return (
    <CreateModal
      isOpen
      onClose={onClose}
      title={`Authentication — ${subscription.name}`}
      onSubmit={async () => {
        try {
          await saveMut.mutateAsync();
        } catch (e) {
          handleError(e);
        }
      }}
      isSubmitting={saveMut.isPending}
      submitLabel="Save"
    >
      <FieldGroup>
        <WebhookAuthFields
          values={values}
          onChange={setField}
          fieldErrors={fieldErrors}
          hasSecret={subscription.hasSecret}
        />
      </FieldGroup>
    </CreateModal>
  );
}
