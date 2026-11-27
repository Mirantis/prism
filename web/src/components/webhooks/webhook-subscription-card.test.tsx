// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WebhookSubscriptionCard } from './webhook-subscription-card';
import type { WebhookSubscription } from '@/types';

const SUBSCRIPTION: WebhookSubscription = {
  id: 'wh-1',
  agentId: 'agent-1',
  name: 'github-review',
  description: null,
  events: null,
  prompt: null,
  deliverTo: 'all',
  slackChannelIds: [],
  deliverOnly: false,
  isActive: true,
  coalesceSeconds: null,
  authType: 'none',
  authHeader: null,
  authPrefix: null,
  authAlgorithm: 'sha256',
  authEncoding: 'hex',
  authSignedUrl: null,
  hasSecret: false,
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T00:00:00.000Z',
};

function renderCard(overrides: Partial<WebhookSubscription>, deliveryLabel: string) {
  render(
    <WebhookSubscriptionCard
      subscription={{ ...SUBSCRIPTION, ...overrides }}
      endpoint={null}
      deliveryLabel={deliveryLabel}
      isUpdating={false}
      onToggle={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
    />,
  );
}

describe('WebhookSubscriptionCard delivery mode', () => {
  it.each([
    ['an agent-mode subscription', { deliverTo: 'slack', deliverOnly: false }, 'Slack', 'Slack · Agent response'],
    ['a deliver-only subscription', { deliverTo: 'chat', deliverOnly: true }, 'Chat', 'Chat · Direct delivery'],
    ['a subscription that delivers nowhere', { deliverTo: 'none', deliverOnly: false }, 'None', 'None · Agent runs'],
  ] as const)('labels %s', (_case, overrides, deliveryLabel, expected) => {
    renderCard(overrides, deliveryLabel);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});
