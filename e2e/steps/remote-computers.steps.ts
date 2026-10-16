/**
 * Remote computer step definitions (web).
 *
 * The computer is `support/fake-computer.ts`, a client that speaks the computer link to
 * the real runtime. Its screen is a page this browser renders, so the agent reads a real
 * picture, and the client records what the runtime asked of it.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { FakeComputer } from '../support/fake-computer';

const { Given, When, Then, After } = createBdd();

/** The computers this scenario connected, by name. */
const computers = new Map<string, FakeComputer>();

function computer(name: string): FakeComputer {
  const found = computers.get(name);
  if (!found) throw new Error(`No computer named ${name} connected in this scenario`);
  return found;
}

After(async () => {
  for (const item of computers.values()) item.close();
  computers.clear();
});

Given(
  'my computer {string} shows the secret word {string} and connects to Prism',
  async ({ browser }, name: string, word: string) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(
      `<body style="margin:0;font:48px system-ui;background:#1e3a5f;color:white">
        <div style="margin:240px auto;width:640px;padding:40px;background:white;color:#111;text-align:center">
        The secret word is <b>${word}</b></div></body>`,
    );
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 80 });
    await page.close();
    computers.set(name, await FakeComputer.connect(name, { jpeg, width: 1280, height: 800 }));
  },
);

Then('{string} is listed as connected', async ({ page }, name: string) => {
  const item = page.getByRole('listitem', { name });
  await expect(item.getByText('Connected', { exact: true })).toBeVisible();
});

Then('{string} was asked for a picture of its screen', async ({}, name: string) => {
  expect(computer(name).requests('screen.capture').length).toBeGreaterThan(0);
});

When('I remove {string} on the Computer page', async ({ page }, name: string) => {
  await page.goto('/computer');
  await page.getByRole('button', { name: `Remove ${name}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
});

Then('{string} is no longer listed', async ({ page }, name: string) => {
  await expect(page.getByRole('listitem', { name })).toHaveCount(0);
});

Then('the computer client of {string} is told its computer was removed', async ({}, name: string) => {
  await expect.poll(() => computer(name).closeCode).toBe(4403);
});
