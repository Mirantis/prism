import type { WebhookDeliverTo, WebhookSubscription } from '@/types';
import { EMPTY_WEBHOOK_AUTH, type WebhookAuthFormValues } from './webhook-auth-fields';

export const DELIVER_LABELS: Record<WebhookDeliverTo, string> = {
  all: 'All channels',
  chat: 'Chat',
  slack: 'Slack',
  teams: 'Microsoft Teams',
  none: 'None',
};

/** Every field of the create and edit forms. Edit leaves `name` alone. */
export interface WebhookSubscriptionFormValues extends WebhookAuthFormValues {
  name: string;
  description: string;
  events: string;
  deliverTo: WebhookDeliverTo;
  deliverOnly: boolean;
  prompt: string;
}

export const EMPTY_WEBHOOK_SUBSCRIPTION_FORM: WebhookSubscriptionFormValues = {
  name: '',
  description: '',
  events: '',
  deliverTo: 'all',
  deliverOnly: false,
  prompt: '',
  ...EMPTY_WEBHOOK_AUTH,
};

/**
 * The edit form's starting values: the stored subscription. The API never
 * returns the secret, so Secret starts empty and an empty field keeps it.
 */
export function subscriptionFormValues(subscription: WebhookSubscription): WebhookSubscriptionFormValues {
  return {
    name: subscription.name,
    description: subscription.description ?? '',
    events: subscription.events ?? '',
    deliverTo: subscription.deliverTo,
    deliverOnly: subscription.deliverOnly,
    prompt: subscription.prompt ?? '',
    authType: subscription.authType,
    authHeader: subscription.authHeader ?? '',
    authPrefix: subscription.authPrefix ?? '',
    authAlgorithm: subscription.authAlgorithm,
    authEncoding: subscription.authEncoding,
    authSignedUrl: subscription.authSignedUrl ?? '',
    secret: '',
  };
}
