/**
 * Live chat on every open client: a second browser context on the same agent.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Given, When, Then, After } = createBdd();

const DAY_MS = 24 * 60 * 60 * 1000;

// Scenarios run one at a time (workers: 1), so module state belongs to the current scenario.
const threadIds = new Map<string, string>();
let second: { context: BrowserContext; page: Page } | undefined;

function secondPage(): Page {
  if (!second) throw new Error('No second browser is open');
  return second.page;
}

/** User bubbles are right-aligned (`justify-end`), agent bubbles are not. */
function userMessages(page: Page, text: string) {
  return page
    .getByTestId('chat-messages')
    .locator('.group.flex.gap-3.justify-end')
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

When('I open the {string} conversation', async ({ page }, title: string) => {
  await openThread(page, title);
});

Then(
  'the second browser shows the message {string} while the agent works',
  async ({}, text: string) => {
    const page = secondPage();
    const home = new HomePage(page);
    await expect(userMessages(page, text)).toHaveCount(1, { timeout: 30_000 });
    // The agent sleeps in its shell, so the reply is some seconds away.
    await expect(home.typingIndicator).toBeVisible();
    await expect(home.stopButton).toBeHidden();
    await expect(home.getAgentMessages()).toHaveCount(0);
  },
);

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
  await expect(replies.first()).toBeVisible({ timeout: 90_000 });
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
