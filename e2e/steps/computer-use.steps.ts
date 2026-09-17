import { createBdd } from 'playwright-bdd';
import { expect, test, type Page } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import { startComputerSite } from '../support/computer-site';
import * as dbHelper from '../support/db-helper';
import { getSlackState } from '../support/slack-state';
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
    `Use your computer to read my inbox at ${site!.url}/inbox and the public notes at ${site!.url}/notes. Report what you find on both pages.`,
  );
  await home.sendMessage();
  await home.waitForAgentResponse(180_000);
  await home.waitForStreamComplete(180_000);
});

Then('Prism requests computer help and reports the public notes', async ({ page }) => {
  await expect(page.getByLabel('Computer help', { exact: true })).toBeVisible();
  const messages = await dbHelper.getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT', internalStep: false },
  });
  expect(messages.map((row) => row.content).join('\n')).toContain('NOTES-42');
  expect(messages.map((row) => row.content).join('\n')).toContain(
    '[Open Computer](http://localhost:5173/computer?help=',
  );
});

Then('the live computer opens over the chat', async ({ page, $testInfo }) => {
  const help = page.getByLabel('Computer help', { exact: true });
  const panel = page.getByLabel('Computer help panel');
  const messages = page.getByTestId('chat-messages');
  const screen = page.getByLabel("The agent's screen");
  await expect(help.getByRole('link', { name: 'Open Computer' })).toHaveCount(0);
  await expect(panel).toHaveAttribute('data-state', 'open', { timeout: 60_000 });
  await expect(screen).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => {
    const box = await screen.boundingBox();
    return box ? Math.abs(box.width / box.height - 16 / 9) : 1;
  }).toBeLessThan(0.01);
  await expect(help.getByRole('button', { name: 'I’m done', exact: true })).toBeEnabled();
  await expect.poll(async () => {
    const panelBox = await panel.boundingBox();
    const messagesBox = await messages.boundingBox();
    const viewport = page.viewportSize();
    return Boolean(
      panelBox &&
      messagesBox &&
      viewport &&
      Math.abs(panelBox.width - viewport.width * 0.6) < 2 &&
      panelBox.x < messagesBox.x + messagesBox.width &&
      panelBox.y === 0 &&
      panelBox.height === viewport.height &&
      panelBox.x + panelBox.width === viewport.width,
    );
  }).toBe(true);
  await page.screenshot({ path: $testInfo.outputPath('computer-in-chat.png'), fullPage: true });
});

Then('I can close and reopen the computer panel', async ({ page }) => {
  const panel = page.getByLabel('Computer help panel');
  await page.getByRole('button', { name: 'Close computer panel' }).click();
  await expect(panel).toHaveAttribute('data-state', 'closed');
  await expect(panel).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Open computer help' }).click();
  await expect(page.getByLabel('Computer help panel')).toHaveAttribute('data-state', 'open');
});

Then('I can resize the computer panel', async ({ page }) => {
  const panel = page.getByLabel('Computer help panel');
  const before = await panel.boundingBox();
  const handle = await page.getByRole('button', { name: 'Resize computer panel' }).boundingBox();
  if (!handle) throw new Error('The computer panel resize handle is not visible.');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 80, handle.y + handle.height / 2);
  await page.mouse.up();
  await expect.poll(async () => {
    const after = await panel.boundingBox();
    return Boolean(after && before && Math.abs(after.width - before.width - 86) < 2);
  }).toBe(true);
});

Then('I can enlarge the chat computer to fullscreen', async ({ page }) => {
  const screen = page.getByLabel("The agent's screen");
  await page.getByRole('button', { name: 'Open fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await expect
    .poll(async () => {
      const box = await screen.boundingBox();
      const viewport = page.viewportSize();
      return Boolean(box && viewport && box.width === viewport.width && box.height === viewport.height);
    })
    .toBe(true);
  await page.getByRole('button', { name: 'Exit fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
});

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
  await expect(page.getByLabel('Computer help panel')).toHaveAttribute('data-state', 'closed');
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
    await expect(page.getByLabel("The agent's screen")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByLabel('Computer help status')).toContainText(
      'Computer help completed',
    );
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
  await expect(page.getByRole('button', { name: 'Mute sound' }))
    .toHaveAttribute('aria-pressed', 'true');
  // Sharing and recording show the agent something, so neither is offered while there is
  // no call to show it to.
  await expect(page.getByRole('button', { name: 'Share your screen', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Record your screen', exact: true })).toBeHidden();
  await expect(page.getByLabel("The agent's screen")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.getByLabel("The agent's screen").evaluate((canvas: HTMLCanvasElement) =>
    ({ width: canvas.width, height: canvas.height })), { timeout: 60_000 })
    .toEqual({ width: 1920, height: 1080 });
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'End voice', exact: true })).toHaveCount(0);
});

When('I start voice on Computer', async ({ page }) => {
  await page.getByRole('button', { name: 'Talk', exact: true }).click();
  await expect(page.getByRole('button', { name: 'End voice', exact: true })).toBeVisible();
  await expect(page.getByLabel('Computer controls').getByRole('button').last()).toHaveText('End voice');
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
  await observer.getByRole('button', { name: 'Return control', exact: true }).click();
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
    .getByLabel('Computer help', { exact: true })
    .getByRole('button', { name: 'Dismiss', exact: true })
    .click();
  await expect(page.getByLabel('Computer help', { exact: true })).toContainText('Dismissed');
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

When('I ask for computer sign-in help from Slack', async () => {
  const slack = getSlackState();
  const result = await slack.userClient!.chat.postMessage({
    channel: slack.channelId,
    text: `<@${slack.botUserId}> Use your computer to read my inbox at ${site!.url}/inbox. If sign-in is required, use computer_help so I can sign in myself.`,
  });
  slack.messageTs = result.ts!;
});

Then('an invalid help continuation keeps my control and the chat waiting', async ({ page }) => {
  const before = await (await page.request.get('/agents/computer')).json();
  expect(before.paused).toBe(true);
  expect(before.controller).toBeTruthy();
  const response = await page.request.post('/agents/computer/help/00000000-0000-4000-8000-000000000000', {
    data: { action: 'continue', clientId: before.controller },
  });
  expect(response.status()).toBe(409);
  const after = await (await page.request.get('/agents/computer')).json();
  expect(after.paused).toBe(true);
  expect(after.controller).toBe(before.controller);
  await expect(queuedChat.getByRole('status')).toContainText('Waiting for the computer');
});
