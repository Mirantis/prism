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
