import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreateModal } from '@/components/shared/create-modal';
import { runtimeApi } from '@/api/runtime-client';
import { useFormErrors } from '@/hooks/use-form-errors';
import { isWebhookAuthComplete } from './webhook-auth-fields';
import { WebhookSubscriptionFields } from './webhook-subscription-fields';
import {
  subscriptionFormValues,
  type WebhookSubscriptionFormValues,
} from './webhook-subscription-form';
import type { WebhookSubscription } from '@/types';

interface WebhookEditDialogProps {
  subscription: WebhookSubscription;
  onClose: () => void;
}

/**
 * Edit every setting of a subscription except its name, which is the endpoint
 * path its sender posts to. The current secret is never sent to the browser,
 * so an empty Secret field means "keep what's stored".
 */
export function WebhookEditDialog({ subscription, onClose }: WebhookEditDialogProps) {
  const queryClient = useQueryClient();
  const { fieldErrors, clearFieldError, handleError, reset: resetErrors } = useFormErrors();
  const [values, setValues] = useState(() => subscriptionFormValues(subscription));

  const setField = <K extends keyof WebhookSubscriptionFormValues>(
    key: K,
    value: WebhookSubscriptionFormValues[K],
  ) => {
    setValues((v) => ({ ...v, [key]: value }));
    clearFieldError(key);
  };

  const saveMut = useMutation({
    mutationFn: () =>
      runtimeApi.updateWebhookSubscription(subscription.id, {
        // An empty string clears the stored value.
        description: values.description.trim(),
        events: values.events.trim(),
        prompt: values.prompt.trim(),
        deliverTo: values.deliverTo,
        deliverOnly: values.deliverOnly,
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
      title={`Edit ${subscription.name}`}
      onSubmit={async () => {
        try {
          await saveMut.mutateAsync();
        } catch (e) {
          handleError(e);
        }
      }}
      isSubmitting={saveMut.isPending}
      submitLabel="Save"
      // Same rule as Create: a scheme needs a header, and a secret unless one
      // is already stored (an empty field keeps it).
      submitDisabled={!isWebhookAuthComplete(values, subscription.hasSecret)}
    >
      <WebhookSubscriptionFields
        mode="edit"
        values={values}
        onChange={setField}
        fieldErrors={fieldErrors}
        hasSecret={subscription.hasSecret}
      />
    </CreateModal>
  );
}
