import { createBdd } from 'playwright-bdd';
import { expect, test, type Page } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import { startComputerSite } from '../support/computer-site';
import * as dbHelper from '../support/db-helper';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { Given, When, Then, After } = createBdd();
let site: Awaited<ReturnType<typeof startComputerSite>> | undefined;
let helpConversationUrl: string;

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
  expect(messages.map((row) => row.content).join('\n')).toContain(
    '[Open Computer](http://localhost:5173/computer?help=',
  );
});

When('I open the Computer help request', async ({ page }) => {
  helpConversationUrl = page.url();
  await page.getByLabel('Computer help').getByRole('link', { name: 'Open Computer' }).click();
  await expect(page.getByLabel("The agent's screen")).toBeVisible();
});

Then(
  'Computer keeps help beside the screen and adapts to smaller displays',
  async ({ page, $testInfo }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const help = page.getByRole('complementary', { name: 'Computer assistance' });
    const screen = page.getByLabel("The agent's screen");
    const controls = page.getByLabel('Computer controls');
    await expect(help).toBeVisible();
    await expect
      .poll(async () => {
        const helpBox = await help.boundingBox();
        const screenBox = await screen.boundingBox();
        const controlsBox = await controls.boundingBox();
        return Boolean(
          helpBox &&
          screenBox &&
          controlsBox &&
          helpBox.x >= screenBox.x + screenBox.width &&
          helpBox.y + helpBox.height <= 900 &&
          controlsBox.y + controlsBox.height <= 900,
        );
      })
      .toBe(true);
    await expect(help.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(1);
    await page.screenshot({ path: $testInfo.outputPath('computer-wide.png'), fullPage: true });
    await page.getByRole('button', { name: 'Open fullscreen' }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
    await expect
      .poll(async () => {
        const box = await screen.boundingBox();
        return Boolean(box && box.width === 1440 && box.height === 900);
      })
      .toBe(true);
    await page.getByRole('button', { name: 'Exit fullscreen' }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await page.setViewportSize({ width: 768, height: 900 });
    await expect
      .poll(async () => {
        const helpBox = await help.boundingBox();
        const screenBox = await screen.boundingBox();
        return Boolean(
          helpBox &&
          screenBox &&
          helpBox.y + helpBox.height <= screenBox.y &&
          helpBox.x + helpBox.width <= 768,
        );
      })
      .toBe(true);
    await page.screenshot({ path: $testInfo.outputPath('computer-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
  },
);

When('I sign in through the live computer', async ({ page, $testInfo }) => {
  page.setDefaultTimeout(15_000);
  await page.getByLabel("The agent's screen").click();
  await expect(page.getByRole('status')).toContainText('You have control', { timeout: 30_000 });
  await page.keyboard.type('demo-user', { delay: 80 });
  await page.screenshot({
    path: $testInfo.outputPath('computer-controlling.png'),
    fullPage: true,
  });
  await page.keyboard.press('Enter');
  // The browser's actual authenticated request confirms the user input arrived.
  await expect.poll(() => site!.isSignedIn(), { timeout: 15_000 }).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status')).not.toContainText('You have control');
});

Then(
  'Prism continues the original conversation and reports the inbox',
  async ({ page, $testInfo }) => {
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
    await page.goto(helpConversationUrl);
    const result = page
      .getByTestId('chat-messages')
      .getByText(/INBOX-CLEAR/)
      .last();
    await result.scrollIntoViewIfNeeded();
    await expect(result).toBeVisible();
    await expect(new HomePage(page).chatInput).toBeEnabled();
    await page.screenshot({ path: $testInfo.outputPath('computer-resumed.png'), fullPage: true });
  },
);

Then('Computer opens without starting voice', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Talk', exact: true })).toBeVisible();
  await expect(page.getByLabel("The agent's screen")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'End voice', exact: true })).toHaveCount(0);
});

When('I start voice on Computer', async ({ page }) => {
  await page.getByRole('button', { name: 'Talk', exact: true }).click();
});

let observer: Page;
let queuedChat: Page;

When('I take control of Computer and open another viewer', async ({ page, context }) => {
  test.setTimeout(180_000);
  // Use native focus changes when switching between viewers.
  const session = await context.newCDPSession(page);
  await page.goto('/computer');
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await page.getByLabel("The agent's screen").click();
  await expect(page.getByRole('status')).toContainText('You have control');
  observer = await context.newPage();
  await observer.goto('/computer');
});

Then('the other viewer can watch but cannot take control', async () => {
  await expect(observer.getByRole('status')).toContainText('Another viewer has control');
  await observer.getByLabel("The agent's screen").click();
  await expect(observer.getByRole('status')).toContainText('Another viewer has control');
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

When('I dismiss the sign-in request and ask about pending computer help', async ({ page }) => {
  await page
    .getByLabel('Computer help')
    .getByRole('button', { name: 'Dismiss', exact: true })
    .click();
  await expect(page.getByLabel('Computer help')).toContainText('Dismissed');
  const home = new HomePage(page);
  await home.typeMessage('Do you still need me to sign in, or is that help request closed?');
  await home.sendMessage();
  await home.waitForAgentResponse(90_000);
  await home.waitForStreamComplete(90_000);
});

Then('Prism confirms the sign-in request is closed', async ({ page, $testInfo }) => {
  await expect(page.getByTestId('chat-messages')).toContainText(
    /(?:dismissed|closed|cancelled|canceled)/i,
  );
  const messages = await dbHelper.getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT', internalStep: false },
    orderBy: { createdAt: 'desc' },
  });
  expect(messages[0]?.content).toMatch(/(?:dismissed|closed|cancelled|canceled)/i);
  const requests = await dbHelper.getPrisma().conversationMessage.findMany({
    where: {
      thread: { agentId: DEFAULT_AGENT_ID },
      blocks: { path: '$[0].type', equals: 'computer_help' },
    },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].blocks).toEqual([expect.objectContaining({ status: 'dismissed' })]);
  await page.screenshot({ path: $testInfo.outputPath('computer-dismissed.png'), fullPage: true });
});
