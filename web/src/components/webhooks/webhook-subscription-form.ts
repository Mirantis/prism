import type { DeliverTo, WebhookSubscription } from '@/types';
import { EMPTY_WEBHOOK_AUTH, type WebhookAuthFormValues } from './webhook-auth-fields';

/** Every field of the create and edit forms. Edit leaves `name` alone. */
export interface WebhookSubscriptionFormValues extends WebhookAuthFormValues {
  name: string;
  description: string;
  events: string;
  deliverTo: DeliverTo;
  /** The Slack channels a Slack delivery posts to; kept while another target is picked. */
  slackChannelIds: string[];
  deliverOnly: boolean;
  /** Whole seconds as typed; empty = one agent run per delivery. */
  coalesceSeconds: string;
  prompt: string;
}

export const EMPTY_WEBHOOK_SUBSCRIPTION_FORM: WebhookSubscriptionFormValues = {
  name: '',
  description: '',
  events: '',
  deliverTo: 'all',
  slackChannelIds: [],
  deliverOnly: false,
  coalesceSeconds: '',
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
    slackChannelIds: subscription.slackChannelIds,
    deliverOnly: subscription.deliverOnly,
    coalesceSeconds: subscription.coalesceSeconds?.toString() ?? '',
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

/** The coalescing window to save: `null` for an empty field. The runtime checks the range. */
export function coalesceSecondsToSave(values: WebhookSubscriptionFormValues): number | null {
  const text = values.coalesceSeconds.trim();
  return text === '' ? null : Number(text);
}

/** The channel list to save: the runtime accepts one for the Slack target only. */
export function slackChannelsToSave(values: WebhookSubscriptionFormValues): string[] {
  return values.deliverTo === 'slack' ? values.slackChannelIds : [];
}
