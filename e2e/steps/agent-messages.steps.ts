/**
 * Messages from other agents: a delivery service posts them to the runtime,
 * signed with its key, whose public half the runtime reads from list_agents. Here the steps post straight to the
 * runtime, signed with a key made for the run, which they give the runtime as
 * list_agents would.
 */

import { randomUUID } from 'node:crypto';
import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { createTestDeliverySigner } from '../../src/test-utils/agent-message-signer';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';
import { getPrisma } from '../support/db-helper';

const { When, Then } = createBdd();

const AGENT_MESSAGES_URL = 'http://localhost:3003/agents/agent-messages';

// Scenarios run one at a time (workers: 1), so module state belongs to the current scenario.
let lastStatus: number | undefined;

const signer = createTestDeliverySigner(DEFAULT_AGENT_ID);

/** Give the runtime the run's key, as list_agents would. Each scenario starts from an empty database. */
async function keepDeliveryKeys(): Promise<void> {
  const { key, value } = signer.keptKeys();
  await getPrisma().runtimeState.upsert({ where: { key }, update: { value }, create: { key, value } });
}

function agentMessage(sender: string, content: string) {
  return {
    id: randomUUID(),
    messageId: randomUUID(),
    conversationId: randomUUID(),
    kind: 'message',
    sender: { id: randomUUID(), name: sender },
    content,
    expectsReply: false,
    attachmentIds: [],
  };
}

When('the agent {string} sends {string} to this agent', async ({}, sender: string, content: string) => {
  await keepDeliveryKeys();
  const body = JSON.stringify(agentMessage(sender, content));
  const response = await fetch(AGENT_MESSAGES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-message-signature': signer.sign(body) },
    body,
  });
  expect(response.status).toBe(202);
});

When(
  'a signed-in person posts {string} as the agent {string}',
  async ({}, content: string, sender: string) => {
    await keepDeliveryKeys();
    const response = await fetch(AGENT_MESSAGES_URL, {
      method: 'POST',
      // What the ingress adds for a person who is signed in. A person holds no
      // key of the delivery service, so the request carries no signature.
      headers: { 'Content-Type': 'application/json', 'x-forwarded-user-id': randomUUID() },
      body: JSON.stringify(agentMessage(sender, content)),
    });
    lastStatus = response.status;
  },
);

Then('the runtime refuses the agent message', async () => {
  expect(lastStatus).toBe(401);
});

Then('the conversation does not show {string}', async ({ page }, text: string) => {
  await expect(page.getByTestId('chat-messages').getByText(text)).toHaveCount(0);
});
