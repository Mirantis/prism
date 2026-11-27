import { describe, expect, it } from 'vitest';
import type { SlackChannelMapping, WebhookSubscription } from '@/types';
import { slackChannelNames } from '@/lib/delivery-labels';
import { coalesceSecondsToSave, slackChannelsToSave, subscriptionFormValues } from './webhook-subscription-form';

const stored: WebhookSubscription = {
  id: 'wh-1',
  agentId: 'agent-1',
  name: 'alerts',
  description: 'Cluster alerts',
  events: 'push,pull_request',
  prompt: 'Alert: {status}',
  deliverTo: 'slack',
  slackChannelIds: ['C_REL'],
  deliverOnly: true,
  isActive: false,
  coalesceSeconds: 30,
  authType: 'hmac',
  authHeader: 'X-Hub-Signature-256',
  authPrefix: 'sha256=',
  authAlgorithm: 'sha512',
  authEncoding: 'base64',
  authSignedUrl: 'https://agent.example.com/agents/webhooks/alerts',
  hasSecret: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

describe('subscriptionFormValues', () => {
  it('starts the edit form from the stored settings, with Secret empty', () => {
    expect(subscriptionFormValues(stored)).toEqual({
      name: 'alerts',
      description: 'Cluster alerts',
      events: 'push,pull_request',
      deliverTo: 'slack',
      slackChannelIds: ['C_REL'],
      deliverOnly: true,
      coalesceSeconds: '30',
      prompt: 'Alert: {status}',
      authType: 'hmac',
      authHeader: 'X-Hub-Signature-256',
      authPrefix: 'sha256=',
      authAlgorithm: 'sha512',
      authEncoding: 'base64',
      authSignedUrl: 'https://agent.example.com/agents/webhooks/alerts',
      secret: '',
    });
  });

  it('shows an unset optional field as empty text', () => {
    const values = subscriptionFormValues({
      ...stored,
      description: null,
      events: null,
      prompt: null,
      authType: 'none',
      authHeader: null,
      authPrefix: null,
      authSignedUrl: null,
      hasSecret: false,
      coalesceSeconds: null,
    });
    expect(values).toMatchObject({
      coalesceSeconds: '',
      description: '',
      events: '',
      prompt: '',
      authHeader: '',
      authPrefix: '',
      authSignedUrl: '',
      secret: '',
    });
  });
});

describe('slackChannelsToSave', () => {
  it('saves the chosen channels for the Slack target and none for another', () => {
    const values = subscriptionFormValues(stored);
    expect(slackChannelsToSave(values)).toEqual(['C_REL']);
    expect(slackChannelsToSave({ ...values, deliverTo: 'chat' })).toEqual([]);
  });
});

describe('coalesceSecondsToSave', () => {
  it('saves the typed seconds, and an empty field as one run per event', () => {
    const values = { ...subscriptionFormValues(stored), deliverOnly: false };
    expect(coalesceSecondsToSave(values)).toBe(30);
    expect(coalesceSecondsToSave({ ...values, coalesceSeconds: ' ' })).toBeNull();
  });

  it('saves no window in Deliver only mode, where the field is hidden', () => {
    const values = { ...subscriptionFormValues(stored), coalesceSeconds: '700' };
    expect(values.deliverOnly).toBe(true);
    expect(coalesceSecondsToSave(values)).toBeNull();
  });
});

describe('slackChannelNames', () => {
  const linked: SlackChannelMapping[] = [
    { id: 'm-1', channelId: 'C_REL', channelName: 'release-notes', agentName: 'Prism', linkedAt: '', isMain: false },
  ];

  it('names a linked channel and shows the id of one unlinked since', () => {
    expect(slackChannelNames(['C_REL', 'C_GONE'], linked)).toBe('#release-notes, C_GONE');
  });
});
