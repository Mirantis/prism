/**
 * File Sharing Step Definitions — web UI upload, chips, download, and the
 * agent reading an uploaded file.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type Download } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { HomePage } from '../pages/home.page';

const { When, Then } = createBdd();

// Tests run sequentially (workers: 1), so a module-level handle is safe.
let lastDownload: Download | undefined;

When(
  'I attach a text file named {string} containing {string}',
  async ({ page }, name: string, content: string) => {
    const homePage = new HomePage(page);
    await homePage.attachFile({ name, mimeType: 'text/plain', content });
    // Wait for the chip to register so the send button correctly blocks on the
    // upload finishing instead of racing a text-only send.
    await expect(homePage.composerAttachment(name)).toBeVisible({ timeout: 10_000 });
  },
);

Then('I should see {string} as an attachment in the composer', async ({ page }, name: string) => {
  const homePage = new HomePage(page);
  await expect(homePage.composerAttachment(name)).toBeVisible({ timeout: 10_000 });
});

When('I remove the attachment {string}', async ({ page }, name: string) => {
  const homePage = new HomePage(page);
  await homePage.removeComposerAttachment(name);
});

Then('I should not see {string} as an attachment in the composer', async ({ page }, name: string) => {
  const homePage = new HomePage(page);
  await expect(homePage.composerAttachment(name)).toHaveCount(0, { timeout: 10_000 });
});

Then('I should see {string} as an attachment on my message', async ({ page }, name: string) => {
  const homePage = new HomePage(page);
  await expect(homePage.messageAttachment(name).first()).toBeVisible({ timeout: 10_000 });
});

Then(
  "I should see {string} as an attachment on the agent's message",
  async ({ page }, name: string) => {
    const homePage = new HomePage(page);
    // The file rides out on the final delivered message, so wait for the
    // stream to finish before asserting the chip is present.
    await homePage.waitForAgentResponse();
    await homePage.waitForStreamComplete();
    await expect(homePage.agentMessageAttachment(name).first()).toBeVisible({ timeout: 60_000 });
  },
);

Then('the agent response should contain {string}', async ({ page }, expected: string) => {
  const homePage = new HomePage(page);
  await homePage.waitForAgentResponse();
  await homePage.waitForStreamComplete();
  await expect(homePage.getAgentMessages().last()).toContainText(expected, { timeout: 60_000 });
});

When('I wait for the agent to finish responding', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.waitForAgentResponse();
  await homePage.waitForStreamComplete();
});

When('I reload the chat page', async ({ page }) => {
  await page.reload();
  await page.waitForLoadState('networkidle');
});

When('I download the attachment {string}', async ({ page }, name: string) => {
  const homePage = new HomePage(page);
  lastDownload = await homePage.downloadAttachment(name);
});

Then('the downloaded file should be named {string}', async ({}, name: string) => {
  expect(lastDownload, 'no download captured — call the download step first').toBeDefined();
  expect(lastDownload!.suggestedFilename()).toBe(name);
});

Then('the downloaded file should contain {string}', async ({}, expected: string) => {
  expect(lastDownload, 'no download captured — call the download step first').toBeDefined();
  const path = await lastDownload!.path();
  const content = await readFile(path, 'utf8');
  expect(content).toContain(expected);
});
