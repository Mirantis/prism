/**
 * Chat Action Step Definitions — the empty conversation's suggestions and the
 * copy buttons on replies and code blocks.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Given, When, Then } = createBdd();

Given(
  'the agent replied with a {string} code block holding {string}',
  async ({}, language: string, code: string) => {
    await dbHelper.createConversation(getCurrentAgentId(), [
      { role: 'USER', content: 'Which command lists every pod?' },
      { role: 'AGENT', content: `Run this:\n\n\`\`\`${language}\n${code}\n\`\`\`` },
    ]);
  },
);

When('I send the {string} suggestion', async ({ page }, title: string) => {
  await new HomePage(page).sendSuggestion(title);
});

When('I copy the agent reply', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const reply = new HomePage(page).getAgentMessages().last();
  // The button shows on hover; hovering is what a pointer user does to reach it.
  await reply.hover();
  await reply.getByTestId('message-copy').click();
});

When('I copy the code block', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('chat-messages').getByTestId('code-copy').click();
});

Then('the code block is labelled {string}', async ({ page }, language: string) => {
  await expect(page.getByTestId('chat-messages').getByTestId('code-language')).toHaveText(language);
});

Then('the clipboard holds {string}', async ({ page }, text: string) => {
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
});

Given('a long conversation that ends with {string}', async ({}, last: string) => {
  // Explicit, increasing times keep the order fixed; rows written in the same millisecond
  // would otherwise tie.
  const start = Date.now() - 60 * 60 * 1000;
  const messages = Array.from({ length: 40 }, (_, i) => ({
    role: (i % 2 === 0 ? 'USER' : 'AGENT') as 'USER' | 'AGENT',
    content: i === 39 ? last : `Message number ${i + 1} in a long conversation.`,
    createdAt: new Date(start + i * 60 * 1000),
  }));
  await dbHelper.createThread(getCurrentAgentId(), { messages });
});

Given(
  'a conversation with {string} from {int} days ago and {string} from today',
  async ({}, older: string, days: number, newer: string) => {
    await dbHelper.createThread(getCurrentAgentId(), {
      messages: [
        { role: 'USER', content: older, createdAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
        { role: 'USER', content: newer, createdAt: new Date() },
      ],
    });
  },
);

When('I scroll to the top of the conversation', async ({ page }) => {
  await page.getByTestId('chat-messages').evaluate((el) => el.scrollTo({ top: 0 }));
});

When('I jump to the latest message', async ({ page }) => {
  await page.getByTestId('jump-to-latest').click();
});

Then('the jump to latest button is shown', async ({ page }) => {
  await expect(page.getByTestId('jump-to-latest')).toBeVisible();
});

Then('the jump to latest button is hidden', async ({ page }) => {
  await expect(page.getByTestId('jump-to-latest')).toBeHidden();
});

Then('the message {string} is in view', async ({ page }, text: string) => {
  await expect(new HomePage(page).getMessageByText(text)).toBeInViewport();
});

Then(
  'the conversation has {int} day dividers, the last one {string}',
  async ({ page }, count: number, last: string) => {
    const dividers = page.getByTestId('day-divider');
    await expect(dividers).toHaveCount(count);
    await expect(dividers.last()).toHaveText(last);
  },
);
