/**
 * Messages from other agents: Irene Agent's backend posts them to the runtime
 * through the Lens Agents private ingress, which sets no person's headers for
 * it. Here the steps post straight to the runtime, as that ingress would.
 */

import { randomUUID } from 'node:crypto';
import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { When, Then } = createBdd();

const AGENT_MESSAGES_URL = 'http://localhost:3003/agents/agent-messages';

// Scenarios run one at a time (workers: 1), so module state belongs to the current scenario.
let lastStatus: number | undefined;

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
  const response = await fetch(AGENT_MESSAGES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agentMessage(sender, content)),
  });
  expect(response.status).toBe(202);
});

When(
  'a signed-in person posts {string} as the agent {string}',
  async ({}, content: string, sender: string) => {
    const response = await fetch(AGENT_MESSAGES_URL, {
      method: 'POST',
      // What the ingress adds for a person who is signed in.
      headers: { 'Content-Type': 'application/json', 'x-forwarded-user-id': randomUUID() },
      body: JSON.stringify(agentMessage(sender, content)),
    });
    lastStatus = response.status;
  },
);

Then('the runtime refuses the agent message', async () => {
  expect(lastStatus).toBe(403);
});

Then('the conversation does not show {string}', async ({ page }, text: string) => {
  await expect(page.getByTestId('chat-messages').getByText(text)).toHaveCount(0);
});
