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

When('I stop the in-progress response', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.stopResponse();
});

Then('the chat composer should be ready for input again', async ({ page }) => {
  const homePage = new HomePage(page);
  // Typing indicator clears (runtime broadcast processing:false) and the
  // STOP button reverts to the send button.
  await homePage.waitForStreamComplete();
  await expect(homePage.sendButton).toBeVisible();
});

Then('I should see my message {string} in the conversation', async ({ page }, text: string) => {
  const homePage = new HomePage(page);
  await expect(homePage.getMessageByText(text)).toBeVisible({ timeout: 10_000 });
});

Then('I should see an agent response in the conversation', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.waitForAgentResponse();
  const agentMessages = homePage.getAgentMessages();
  await expect(agentMessages.first()).toBeVisible();

  // Wait for streaming to finish before reading text, otherwise we'd race the
  // partial frames. Agent-runtime surfaces LLM failures as a bubble starting
  // with "I encountered an error…" (see lib/llm-errors.ts#buildErrorStep), so
  // anchor the rejection to that prefix rather than a bare substring.
  await homePage.waitForStreamComplete();
  await expect(agentMessages.last()).not.toHaveText(/^\s*I encountered an error/i);
});

Then('I should see the message {string} in the conversation', async ({ page }, text: string) => {
  const homePage = new HomePage(page);
  await expect(homePage.getMessageByText(text)).toBeVisible({ timeout: 10_000 });
});
