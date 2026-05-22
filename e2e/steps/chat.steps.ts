/**
 * Chat Step Definitions
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { HomePage } from '../pages/home.page';

const { When, Then } = createBdd();

When('I type {string} in the chat input', async ({ page }, text: string) => {
  const homePage = new HomePage(page);
  await homePage.typeMessage(text);
});

When('I send the message', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.sendMessage();
});

Then('I should see my message {string} in the conversation', async ({ page }, text: string) => {
  const homePage = new HomePage(page);
  await expect(homePage.getMessageByText(text)).toBeVisible({ timeout: 10_000 });
});

Then('I should see an agent response in the conversation', async ({ page }) => {
  const homePage = new HomePage(page);
  // Wait longer for real LLM response from Bedrock
  await homePage.waitForAgentResponse(13_000);
  const agentMessages = homePage.getAgentMessages();
  await expect(agentMessages.first()).toBeVisible();

  // Agent-runtime surfaces LLM failures as a response bubble starting with
  // "I encountered an error…" — reject any bubble containing "error" so the
  // test doesn't pass on degraded responses.
  const latestAgentMessage = agentMessages.last();
  const text = (await latestAgentMessage.textContent()) ?? '';
  expect(text.toLowerCase()).not.toContain('error');
});

Then('I should see the message {string} in the conversation', async ({ page }, text: string) => {
  const homePage = new HomePage(page);
  await expect(homePage.getMessageByText(text)).toBeVisible({ timeout: 10_000 });
});
