import { createBdd } from 'playwright-bdd';
import { expect, test, type Page } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import { startComputerSite } from '../support/computer-site';
import * as dbHelper from '../support/db-helper';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { Given, When, Then, After } = createBdd();
let site: Awaited<ReturnType<typeof startComputerSite>> | undefined;

After(async () => {
  await site?.close();
  site = undefined;
});

Given('a website with a sign-in page and public notes', async () => {
  site = await startComputerSite();
});

When('I ask Prism to read my inbox and the public notes using its computer', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/chat');
  const home = new HomePage(page);
  await home.typeMessage(
    `Use your computer to read my inbox at ${site!.url}/inbox and the public notes at ${site!.url}/notes. If the inbox requires sign-in, ask me for help and preserve that tab. Read the public notes while waiting and report their reference. Let me enter the account information myself.`,
  );
  await home.sendMessage();
  await home.waitForAgentResponse(180_000);
  await home.waitForStreamComplete(180_000);
});

Then('Prism requests computer help and reports the public notes', async ({ page }) => {
  await expect(page.getByLabel('Computer help')).toBeVisible();
  const messages = await dbHelper.getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT', internalStep: false },
  });
  expect(messages.map((row) => row.content).join('\n')).toContain('NOTES-42');
});

When('I open the help request and sign in through the live computer', async ({ page }) => {
  await page.getByLabel('Computer help').getByRole('link', { name: 'Open Computer' }).click();
  page.setDefaultTimeout(15_000);
  const help = page.getByLabel('Computer help');
  await help.getByRole('button', { name: 'Take control' }).click();
  await expect(page.getByRole('status')).toContainText('You have control', { timeout: 30_000 });
  await page.getByLabel("The agent's screen").click();
  await page.keyboard.type('demo-user', { delay: 80 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  // The browser's actual authenticated request confirms the user input arrived.
  await expect.poll(() => site!.isSignedIn(), { timeout: 15_000 }).toBe(true);
  await help.getByRole('button', { name: 'Continue', exact: true }).click();
});

Then('Prism continues the original conversation and reports the inbox', async () => {
  await expect
    .poll(
      async () => {
        const messages = await dbHelper.getPrisma().conversationMessage.findMany({
          where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT', internalStep: false },
        });
        return messages.map((row) => row.content).join('\n');
      },
      { timeout: 180_000 },
    )
    .toContain('INBOX-CLEAR');
});

Then('Computer opens without starting voice', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Talk', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await expect(page.getByRole('button', { name: 'End voice', exact: true })).toHaveCount(0);
});

When('I start voice on Computer', async ({ page }) => {
  await page.getByRole('button', { name: 'Talk', exact: true }).click();
});

let observer: Page;
let queuedChat: Page;

When('I take control of Computer and open another viewer', async ({ page, context }) => {
  test.setTimeout(180_000);
  await page.goto('/computer');
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('You have control');
  observer = await context.newPage();
  await observer.goto('/computer');
});

Then('the other viewer can watch but cannot take control', async () => {
  await expect(observer.getByRole('status')).toContainText('Another viewer has control');
  await expect(observer.getByRole('button', { name: 'Take control', exact: true })).toBeDisabled();
  await expect(observer.getByLabel("The agent's screen")).toBeVisible();
});

When('I ask for the public notes in a chat while I have control', async ({ context }) => {
  queuedChat = await context.newPage();
  await queuedChat.goto('/chat');
  const home = new HomePage(queuedChat);
  await home.typeMessage(
    `Use your computer's browser to read ${site!.url}/notes and report the reference.`,
  );
  await home.sendMessage();
});

Then('the chat shows that it is waiting for the computer', async () => {
  await expect(queuedChat.getByRole('status')).toContainText('Waiting for the computer', {
    timeout: 60_000,
  });
});

When('I close the controlling viewer and continue from the other viewer', async ({ page }) => {
  await page.close();
  await expect(observer.getByRole('status')).toContainText('Paused');
  await expect(queuedChat.getByRole('status')).toContainText('Waiting for the computer');
  await observer.getByRole('button', { name: 'Continue', exact: true }).click();
});

Then('the queued chat reports the public notes', async () => {
  await expect(queuedChat.getByTestId('chat-messages')).toContainText('NOTES-42', {
    timeout: 90_000,
  });
  await expect(queuedChat.getByRole('status')).toHaveCount(0);
  await observer.close();
  await queuedChat.close();
});
