import { describe, expect, it } from 'vitest';
import type { WebhookSubscription } from '@/types';
import { subscriptionFormValues } from './webhook-subscription-form';

const stored: WebhookSubscription = {
  id: 'wh-1',
  agentId: 'agent-1',
  name: 'alerts',
  description: 'Cluster alerts',
  events: 'push,pull_request',
  prompt: 'Alert: {status}',
  deliverTo: 'slack',
  deliverOnly: true,
  isActive: false,
  authType: 'hmac',
  authHeader: 'X-Hub-Signature-256',
  authPrefix: 'sha256=',
  authAlgorithm: 'sha512',
  authEncoding: 'base64',
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
      deliverOnly: true,
      prompt: 'Alert: {status}',
      authType: 'hmac',
      authHeader: 'X-Hub-Signature-256',
      authPrefix: 'sha256=',
      authAlgorithm: 'sha512',
      authEncoding: 'base64',
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
      hasSecret: false,
    });
    expect(values).toMatchObject({
      description: '',
      events: '',
      prompt: '',
      authHeader: '',
      authPrefix: '',
      secret: '',
    });
  });
});
