/**
 * One conversation on every open client: a second browser context on the same agent.
 *
 * Another person is a socket of its own that names them in the headers the Mirantis
 * Agent Platform ingress writes for a signed-in caller: `x-forwarded-user` (their email),
 * `x-forwarded-user-id` and the percent-encoded `x-forwarded-user-display-name`.
 * A browser cannot set a header on a WebSocket handshake, so they are not a
 * browser here.
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createBdd } from 'playwright-bdd';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';
import { DAY_MS } from '../fixtures/test-data';

const { Given, When, Then, After } = createBdd();

// Scenarios run one at a time (workers: 1), so module state belongs to the current scenario.
const threadIds = new Map<string, string>();
let second: { context: BrowserContext; page: Page } | undefined;
const others: WebSocket[] = [];

function secondPage(): Page {
  if (!second) throw new Error('No second browser is open');
  return second.page;
}

/** A person's messages, this browser's own or someone else's. */
function userMessages(page: Page, text: string) {
  return page
    .getByTestId('chat-messages')
    .locator('[data-message-role="user"], [data-message-role="participant"]')
    .filter({ hasText: text });
}

/**
 * The indicator can be on screen for less time than a poll takes, for example on a request that
 * fails at once. The script sets a flag when the indicator first appears, from the first paint on.
 */
function watchTypingIndicator() {
  const w = window as unknown as { __typingSeen: boolean };
  w.__typingSeen = false;
  new MutationObserver(() => {
    if (document.querySelector('[data-testid="chat-typing-indicator"]')) w.__typingSeen = true;
  }).observe(document, { childList: true, subtree: true });
}

function typingSeen(page: Page) {
  return page.evaluate(() => (window as unknown as { __typingSeen: boolean }).__typingSeen);
}

/**
 * Open a thread and wait for its socket. Send becomes enabled only when the socket is connected
 * and the composer holds text, so the draft is typed and then cleared.
 */
async function openThread(page: Page, title: string) {
  const threadId = threadIds.get(title);
  if (!threadId) throw new Error(`No conversation titled "${title}"`);
  const home = new HomePage(page);
  await home.goto(`/chat/${threadId}`);
  await page.waitForLoadState('networkidle');
  await home.typeMessage('draft');
  await expect(home.sendButton).toBeEnabled({ timeout: 30_000 });
  await home.typeMessage('');
}

After(async () => {
  await second?.context.close();
  second = undefined;
  for (const socket of others.splice(0)) socket.close();
  threadIds.clear();
});

Given('a web conversation titled {string}', async ({}, title: string) => {
  threadIds.set(title, await dbHelper.createThread(getCurrentAgentId(), { title }));
});

Given('an older web conversation titled {string}', async ({}, title: string) => {
  const createdAt = new Date(Date.now() - DAY_MS);
  threadIds.set(title, await dbHelper.createThread(getCurrentAgentId(), { title, createdAt }));
});

Given(
  'a second browser has the {string} conversation open',
  async ({ browser, baseURL }, title: string) => {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.addInitScript(watchTypingIndicator);
    second = { context, page };
    await openThread(page, title);
  },
);

When(
  '{string}, signed in as {string}, sends {string} to the {string} conversation',
  async ({}, name: string, email: string, text: string, title: string) => {
    const threadId = threadIds.get(title);
    if (!threadId) throw new Error(`No conversation titled "${title}"`);
    const socket = new WebSocket('ws://localhost:3003/api/ws', {
      headers: {
        'x-forwarded-user': email,
        'x-forwarded-user-id': randomUUID(),
        'x-forwarded-user-display-name': encodeURIComponent(name),
      },
    });
    others.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    // Fails at once if the runtime closes the socket, rather than at the step timeout.
    const answer = (match: (frame: { type: string; re?: string }) => boolean) =>
      new Promise<{ type: string }>((resolve, reject) => {
        const onMessage = (data: WebSocket.RawData) => {
          const frame = JSON.parse(data.toString()) as { type: string; re?: string };
          if (!match(frame)) return;
          socket.off('message', onMessage);
          resolve(frame);
        };
        socket.on('message', onMessage);
        socket.once('close', (code) => reject(new Error(`the runtime closed the socket (${code})`)));
      });
    const welcomed = answer((f) => f.type === 'welcome');
    socket.send(JSON.stringify({ type: 'hello', id: 'hello', payload: { protocol: 2, client: { name: 'e2e' } } }));
    await welcomed;
    const confirmed = answer((f) => f.re === 'participant-send');
    socket.send(
      JSON.stringify({
        type: 'send',
        id: 'participant-send',
        payload: { message: { id: randomUUID(), threadId, content: text, attachmentIds: [] } },
      }),
    );
    expect((await confirmed).type).toBe('ack');
  },
);

Then(
  'I see the message {string} from {string} among the other participants',
  async ({ page }, text: string, name: string) => {
    const message = page
      .getByTestId('chat-messages')
      .locator('[data-message-role="participant"]')
      .filter({ hasText: text });
    await expect(message).toHaveCount(1, { timeout: 30_000 });
    await expect(message.getByTestId('message-sender')).toHaveText(name);
  },
);

When('I open the {string} conversation', async ({ page }, title: string) => {
  await openThread(page, title);
});

Then(
  'the second browser shows the message {string} while the agent works',
  async ({}, text: string) => {
    const page = secondPage();
    const home = new HomePage(page);
    await expect(userMessages(page, text)).toHaveCount(1, { timeout: 30_000 });
    // The agent sleeps in its shell, so the reply is some seconds away. Any
    // client can stop the agent, so STOP shows here too.
    await expect(home.typingIndicator).toBeVisible();
    await expect(home.stopButton).toBeVisible();
    await expect(home.getAgentMessages()).toHaveCount(0);
  },
);

When('the second browser stops the response', async () => {
  const home = new HomePage(secondPage());
  await home.stopButton.click();
});

When('the second browser goes offline until the agent has replied', async ({ page }) => {
  const { context } = second ?? {};
  if (!context) throw new Error('No second browser is open');
  await expect(new HomePage(secondPage()).typingIndicator).toBeVisible({ timeout: 30_000 });
  await context.setOffline(true);
  // The reply is published while nobody on the second browser can hear it.
  await new HomePage(page).waitForStreamComplete(120_000);
  await context.setOffline(false);
});

When('the second browser sends {string}', async ({}, text: string) => {
  const home = new HomePage(secondPage());
  await home.typeMessage(text);
  await home.sendButton.click();
});

Then('the second browser shows the message waiting for another conversation', async () => {
  await expect(new HomePage(secondPage()).queuedIndicator).toBeVisible({ timeout: 30_000 });
});

Then('the second browser shows the working indicator', async () => {
  await expect(new HomePage(secondPage()).typingIndicator).toBeVisible({ timeout: 30_000 });
});

Then('the second browser showed the working indicator', async () => {
  expect(await typingSeen(secondPage())).toBe(true);
});

Then('the second browser never showed the working indicator', async ({ page }) => {
  await new HomePage(page).waitForStreamComplete();
  expect(await typingSeen(secondPage())).toBe(false);
});

Then('the second browser shows no working indicator', async () => {
  await expect(new HomePage(secondPage()).typingIndicator).toBeHidden({ timeout: 30_000 });
});

Then('the second browser shows a reply containing {string}', async ({}, text: string) => {
  const replies = new HomePage(secondPage()).getAgentMessages().filter({ hasText: text });
  await expect(replies.first()).toBeVisible({ timeout: 120_000 });
});

Then('the second browser shows the message {string} once', async ({}, text: string) => {
  await expect(userMessages(secondPage(), text)).toHaveCount(1);
});

Then('the second browser does not show the message {string}', async ({}, text: string) => {
  await expect(secondPage().getByTestId('chat-messages').getByText(text)).toHaveCount(0);
});

Then('I see my message {string} once', async ({ page }, text: string) => {
  await new HomePage(page).waitForStreamComplete();
  await expect(userMessages(page, text)).toHaveCount(1);
});
