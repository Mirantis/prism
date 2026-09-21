import WebSocket from 'ws';
import { createBdd } from 'playwright-bdd';
import { expect, test, type Page } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import { SIGN_IN_PASSWORD, startComputerSite } from '../support/computer-site';
import * as dbHelper from '../support/db-helper';
import { getSlackState } from '../support/slack-state';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { Given, When, Then, After } = createBdd();
let site: Awaited<ReturnType<typeof startComputerSite>> | undefined;

After(async ({ context }) => {
  await site?.close();
  site = undefined;
  // Control survives closing a viewer, and every later turn waits on the computer, so a
  // scenario that fails while holding control or leaving work queued would stall the next one.
  const status = async () => (await context.request.get('/agents/computer')).json();
  if ((await status()).paused) {
    for (const open of context.pages()) await open.close();
    const viewer = await context.newPage();
    await viewer.goto('/computer');
    await viewer.getByRole('button', { name: 'Return control', exact: true }).click();
    await expect.poll(async () => (await status()).paused).toBe(false);
    await viewer.close();
  }
  await expect
    .poll(
      async () => {
        const now = await status();
        if (now.owner) await context.request.post('/agents/computer/stop');
        return Boolean(now.owner) || now.waiting.length > 0;
      },
      { timeout: 60_000 },
    )
    .toBe(false);
});

Given('a website with a sign-in page and public notes', async () => {
  site = await startComputerSite();
});

When('I ask Prism to read my inbox and the public notes using its computer', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/chat');
  const home = new HomePage(page);
  await home.typeMessage(
    `Use your computer to read my inbox at ${site!.url}/inbox and the public notes at ${site!.url}/notes. ` +
      'If the inbox needs sign-in, call computer_help so I can sign in on the desktop. ' +
      'Do not ask for credentials in chat. Report what you find on both pages.',
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
  await expect(panel.getByText('Click the desktop to help')).toHaveCount(0);
  await expect(panel.getByText('Needs your help')).toHaveCount(0);
  await expect
    .poll(() =>
      panel.evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          style.transitionProperty.includes('transform') &&
          style.transitionDuration === '1.2s' &&
          style.opacity === '1'
        );
      }),
    )
    .toBe(true);
  await expect.poll(async () => {
    const box = await screen.boundingBox();
    return box ? Math.abs(box.width / box.height - 16 / 9) : 1;
  }).toBeLessThan(0.01);
  await expect(help.getByRole('button', { name: 'I’m done', exact: true })).toBeEnabled();
  await expect.poll(async () => {
    const panelBox = await panel.boundingBox();
    const messagesBox = await messages.boundingBox();
    // Stop sits left of Send, so Send's right edge bounds both controls.
    const sendBox = await page.getByRole('button', { name: /^Send/ }).boundingBox();
    const viewport = page.viewportSize();
    return Boolean(
      panelBox &&
      messagesBox &&
      sendBox &&
      viewport &&
      Math.abs(panelBox.width - viewport.width * 0.5) < 2 &&
      panelBox.x < messagesBox.x + messagesBox.width &&
      sendBox.x + sendBox.width <= panelBox.x &&
      panelBox.y === 0 &&
      panelBox.height === viewport.height &&
      panelBox.x + panelBox.width === viewport.width,
    );
  }).toBe(true);
  await page.screenshot({ path: $testInfo.outputPath('computer-in-chat.png'), fullPage: true });
});

Then('the Computer page shows the same help beside the screen', async ({ page, context }) => {
  const status = await (await page.request.get('/agents/computer')).json() as {
    help?: { id: string; reason: string; status: string }[];
  };
  const waiting = status.help?.find((item) => item.status === 'waiting');
  expect(waiting).toBeDefined();
  const viewer = await context.newPage();
  try {
    await viewer.goto(`/computer?help=${waiting!.id}`);
    await expect(viewer.getByLabel('Computer assistance')).toContainText(waiting!.reason);
    await expect(viewer.getByLabel("The agent's screen")).toBeVisible();
  } finally {
    await viewer.close();
  }
});

Then('I can close and reopen the computer panel', async ({ page }) => {
  const panel = page.getByLabel('Computer help panel');
  await page.getByRole('button', { name: 'Close computer panel' }).click();
  await expect(panel).toHaveAttribute('data-state', 'closed');
  await expect(panel).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole('button', { name: /Computer help requested/ }).click();
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
  await expect.poll(async () => {
    const panelBox = await panel.boundingBox();
    const sendBox = await page.getByRole('button', { name: /^Send/ }).boundingBox();
    return Boolean(panelBox && sendBox && sendBox.x + sendBox.width <= panelBox.x);
  }).toBe(true);
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

Then('I can close and reopen the panel after control loses focus', async ({ page }) => {
  const panel = page.getByLabel('Computer help panel');
  await page.getByLabel("The agent's screen").click();
  await expect.poll(async () => {
    const status = await (await page.request.get('/agents/computer')).json();
    return status.controller;
  }).toBeTruthy();

  // A focus loss releases pointer lock without invoking ScreenView's hand-back.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    document.exitPointerLock();
  });
  await page.getByRole('button', { name: 'Close computer panel' }).click();
  await expect(panel).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => {
    const status = await (await page.request.get('/agents/computer')).json();
    return status.paused;
  }).toBe(false);

  await page.getByRole('button', { name: /Computer help requested/ }).click();
  await expect(panel).toHaveAttribute('data-state', 'open');
});

/**
 * Put the sign-in page in front of whatever the agent left in the tab.
 *
 * A help request preserves the tab, not the page: asked for something else as well, the
 * agent may navigate that tab on before it hands over, and the keystrokes would land
 * wherever it went. Done the way a person would fix it — the address bar, the address,
 * Enter — which also puts the caret in the password field, since the page asks for it on
 * load.
 */
async function openSignInPage(page: Page): Promise<void> {
  // A click first, where the pointer already is, which is over the browser: taking
  // control claims the pointer but focuses nothing on the desktop, and a key only
  // reaches the window that has the keyboard. Measured on a desktop nobody had touched:
  // without this the address below arrives nowhere, however often it is typed.
  await page.mouse.down();
  await page.mouse.up();
  const before = site!.signInPageLoads();
  // Typed again until the site has served the page: a key can be lost on its way to a
  // desktop that has just changed hands, and the load is the only proof it arrived.
  await expect
    .poll(
      async () => {
        if (site!.signInPageLoads() > before) return true;
        await page.keyboard.press('Control+l');
        await page.keyboard.type(`${site!.url}/inbox`, { delay: 20 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2_000);
        return site!.signInPageLoads() > before;
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBe(true);
}

When('I ask Prism to read my mail using its computer', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/chat');
  const home = new HomePage(page);
  await home.typeMessage(
    `Use your computer to read my mail at ${site!.url}/mail and report what it says. ` +
      'Ask me for the username and password when you need them.',
  );
  await home.sendMessage();
  await home.waitForAgentResponse(180_000);
  await home.waitForStreamComplete(180_000);
});

/** A sign-in is answered where the message is, so the live desktop never slides over it. */
Then('Prism asks for the sign-in in the chat, with a box for it', async ({ page, $testInfo }) => {
  const box = page.getByLabel('Computer sign-in');
  await expect(box).toBeVisible({ timeout: 60_000 });
  await expect(box.getByText(new URL(site!.url).origin)).toBeVisible();
  await expect(page.getByLabel('Computer help panel')).toHaveCount(0);
  await box.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.getByLabel('Sign in for Prism')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open sign-in' }).click();
  await expect(box.getByLabel('Username', { exact: true })).toBeVisible();
  await expect(box.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  await page.screenshot({ path: $testInfo.outputPath('computer-sign-in-box.png'), fullPage: true });
});

When('I fill in the username and password and submit', async ({ page }) => {
  const form = page.getByLabel('Sign in for Prism');
  await form.getByLabel('Username').fill('demo-user');
  await form.getByLabel('Password').fill('a-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
});

Then('the website has both of them, and Prism reports the mail', async ({ page, $testInfo }) => {
  await expect.poll(() => site!.mailCredentials(), { timeout: 60_000 }).toEqual({
    username: 'demo-user',
    password: 'a-password',
  });
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
    .toContain('MAIL-CLEAR');
  await page.screenshot({ path: $testInfo.outputPath('computer-signed-in.png'), fullPage: true });
});

When('I sign in through the live computer', async ({ page, $testInfo }) => {
  page.setDefaultTimeout(15_000);
  await page.getByLabel("The agent's screen").click();
  const controlStatus = page.getByText('Taking control…', { exact: true });
  await expect(controlStatus).toBeVisible();
  await expect
    .poll(async () => {
      const status = await (await page.request.get('/agents/computer')).json();
      return status.controller;
    }, { timeout: 30_000 })
    .toBeTruthy();
  await expect(controlStatus).toHaveCount(0, { timeout: 30_000 });
  await openSignInPage(page);
  await page.keyboard.type(SIGN_IN_PASSWORD, { delay: 60 });
  await expect.poll(() => site!.passwordLength(), { timeout: 15_000 }).toBeGreaterThan(0);
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
  await expect(queuedChat.getByTestId('computer-waiting')).toContainText('Waiting for the computer', {
    timeout: 60_000,
  });
});

When('I close the controlling viewer and continue from the other viewer', async ({ page }) => {
  await page.close();
  await expect(observer.getByRole('status')).toContainText('Paused');
  await expect(queuedChat.getByTestId('computer-waiting')).toContainText('Waiting for the computer');
  await observer.getByRole('button', { name: 'Return control', exact: true }).click();
});

Then('the queued chat reports the public notes', async () => {
  await expect(queuedChat.getByTestId('chat-messages')).toContainText('NOTES-42', {
    timeout: 90_000,
  });
  await expect(queuedChat.getByTestId('computer-waiting')).toHaveCount(0);
  await observer.close();
  await queuedChat.close();
});

When('I dismiss the sign-in request and ask about pending computer help', async ({ page }) => {
  await page
    .getByLabel('Computer help', { exact: true })
    .getByRole('button', { name: 'Dismiss', exact: true })
    .click();
  await expect(page.getByLabel('Computer help status')).toContainText('Computer help dismissed');
  await expect(page.getByLabel('Computer help panel')).toHaveCount(0, { timeout: 15_000 });
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
  await expect(queuedChat.getByTestId('computer-waiting')).toContainText('Waiting for the computer');
});

/** The client that waits out a secure takeover, and what the agent had answered before it. */
let quietSocket: WebSocket | undefined;
let answersBeforeTakeover = 0;

const countAnswers = () =>
  dbHelper.getPrisma().conversationMessage.count({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT', internalStep: false },
  });

/** What the agent has said lately, for a question whose answer is one word. */
const answerText = async () => {
  const rows = await dbHelper.getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT', internalStep: false },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  return rows.map((row) => row.content).join('\n');
};

/**
 * The inbox alone, unlike the scenario above.
 *
 * Which tab the agent leaves in front is its own business, and the help request carries
 * that tab: asked for the notes as well, it can hand over a desktop showing them, and the
 * keystrokes below would land on the wrong page.
 */
When('I ask Prism to read my inbox using its computer', async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto('/chat');
  const home = new HomePage(page);
  await home.typeMessage(
    `Use your computer to read my inbox at ${site!.url}/inbox and tell me what it says. ` +
      'It needs a sign-in you cannot do: call computer_help so I can sign in myself.',
  );
  await home.sendMessage();
  await home.waitForAgentResponse(180_000);
  await home.waitForStreamComplete(180_000);
});

Then('Prism requests computer help', async ({ page }) => {
  await expect(page.getByLabel('Computer help', { exact: true })).toBeVisible();
});

When('I open the help request on the Computer page', async ({ page }) => {
  const status = (await (await page.request.get('/agents/computer')).json()) as {
    help?: { id: string; status: string }[];
  };
  const waiting = status.help?.find((item) => item.status === 'waiting');
  expect(waiting).toBeDefined();
  await page.goto(`/computer?help=${waiting!.id}`);
  await expect(page.getByLabel("The agent's screen")).toBeVisible({ timeout: 60_000 });
});

When('I take control for the help request and type a password', async ({ page, $testInfo }) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(15_000);
  await page.getByLabel("The agent's screen").click();
  await expect(page.getByRole('status')).toContainText('You have control', { timeout: 30_000 });
  await openSignInPage(page);
  await page.keyboard.type(SIGN_IN_PASSWORD, { delay: 60 });
  await expect.poll(() => site!.passwordLength(), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.screenshot({
    path: $testInfo.outputPath('computer-secure-takeover.png'),
    fullPage: true,
  });
});

Then('Computer says Prism is stopped, and a question in another chat goes unanswered', async ({
  page,
}) => {
  await expect(page.getByRole('status')).toContainText('Prism is stopped');
  answersBeforeTakeover = await countAnswers();
  // A question needing no computer at all, asked on a socket of its own rather than in a
  // second tab: opening one takes this page's pointer lock, and the keyboard a takeover
  // gives you goes with it.
  quietSocket = new WebSocket('ws://localhost:3003/api/ws');
  await new Promise<void>((resolve, reject) => {
    quietSocket!.once('open', resolve);
    quietSocket!.once('error', reject);
  });
  quietSocket.send(
    JSON.stringify({
      type: 'chat',
      payload: { content: 'Reply with the single word ACKNOWLEDGED. Use no tools.' },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20_000));
  expect(await countAnswers()).toBe(answersBeforeTakeover);
});

When('I hand the computer back without signing in', async ({ page }) => {
  // Esc rather than the card's button: the screen holds the pointer, so it takes every
  // click on the page until this gives the pointer back.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status')).not.toContainText('You have control');
});

Then(
  'the password I typed is gone, and Prism answers the waiting question',
  async ({ page, $testInfo }) => {
    await expect.poll(() => site!.passwordLength(), { timeout: 30_000 }).toBe(0);
    expect(site!.isSignedIn()).toBe(false);
    // The question itself, rather than any answer anywhere: handing back also
    // continues the help request, and that reply would satisfy a count.
    await expect.poll(answerText, { timeout: 180_000 }).toContain('ACKNOWLEDGED');
    await page.screenshot({
      path: $testInfo.outputPath('computer-secure-cleared.png'),
      fullPage: true,
    });
    // Handing back also continues the help request, and that turn outlives these
    // assertions. A scenario that ends while it runs leaves it holding the computer
    // and the user's message queue, which stalls every scenario after this one.
    await waitForQuiet(page);
    quietSocket?.close();
    quietSocket = undefined;
  },
);

/**
 * Wait for the agent to stop working: two readings in a row with the same number of
 * answers and nothing using or queued for the computer. An invocation keeps the
 * computer from its first tool call until it ends, so a free computer and a steady
 * count together mean no turn is in flight.
 */
async function waitForQuiet(page: Page): Promise<void> {
  let previous = -1;
  await expect
    .poll(
      async () => {
        const answers = await countAnswers();
        const computer = await (await page.request.get('/agents/computer')).json();
        const quiet = answers === previous && !computer.owner && computer.waiting.length === 0;
        previous = answers;
        return quiet;
      },
      { timeout: 180_000, intervals: [5_000] },
    )
    .toBe(true);
}
