import type { SlackChannelMapping, WebhookDeliverTo, WebhookSubscription } from '@/types';
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
  /** The Slack channels a Slack delivery posts to; kept while another target is picked. */
  slackChannelIds: string[];
  deliverOnly: boolean;
  prompt: string;
}

export const EMPTY_WEBHOOK_SUBSCRIPTION_FORM: WebhookSubscriptionFormValues = {
  name: '',
  description: '',
  events: '',
  deliverTo: 'all',
  slackChannelIds: [],
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
    slackChannelIds: subscription.slackChannelIds,
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

/** The channel list to save: the runtime accepts one for the Slack target only. */
export function slackChannelsToSave(values: WebhookSubscriptionFormValues): string[] {
  return values.deliverTo === 'slack' ? values.slackChannelIds : [];
}

/** `#name` for each chosen channel; one no longer linked shows its id. */
export function slackChannelNames(ids: string[], linked: SlackChannelMapping[]): string {
  return ids
    .map((id) => {
      const channel = linked.find((c) => c.channelId === id);
      return channel ? `#${channel.channelName ?? id}` : id;
    })
    .join(', ');
}
