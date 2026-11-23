/**
 * Spending step definitions: the spending endpoints, read from the page the user
 * is signed in to, against the message the user sent.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { deriveThreadTitle } from '../../src/utils/thread-title';
import { HomePage } from '../pages/home.page';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Given, When, Then } = createBdd();

interface Spend {
  costUsd: number;
  calls: number;
  unpricedCalls: number;
}

/** The newest message the user sent, read per call: each scenario starts on an empty database. */
async function myMessage(): Promise<{ id: string; threadId: string }> {
  const message = await dbHelper.getPrisma().conversationMessage.findFirst({
    where: { role: 'USER', internalStep: false },
    orderBy: { createdAt: 'desc' },
    select: { id: true, threadId: true },
  });
  if (!message) throw new Error('no user message stored');
  return message;
}

async function getJson<T>(page: Page, path: string): Promise<{ status: number; body: T }> {
  return page.evaluate(async (url) => {
    const res = await fetch(url);
    return { status: res.status, body: await res.json() };
  }, path);
}

Then('the spending of my message is above zero, with every call priced', async ({ page }) => {
  const { id } = await myMessage();
  // Each call is recorded as it returns, so poll until the turn's calls are in.
  await expect
    .poll(async () => {
      const { status, body } = await getJson<Spend & { byKind: Array<{ kind: string }> }>(page, `/agents/spending/requests/${id}`);
      return status === 200 && body.costUsd > 0 && body.calls > 0 && body.unpricedCalls === 0 && body.byKind[0]?.kind === 'main';
    }, { timeout: 15_000 })
    .toBe(true);
});

Then('my message is listed in the spending of its conversation', async ({ page }) => {
  const { id, threadId } = await myMessage();
  const { body: thread } = await getJson<Spend & { requests: Array<Spend & { requestId: string }> }>(
    page,
    `/agents/spending/threads/${threadId}`,
  );
  const { body: request } = await getJson<Spend>(page, `/agents/spending/requests/${id}`);

  expect(thread.requests.find((r) => r.requestId === id)).toMatchObject({ costUsd: request.costUsd, calls: request.calls });
  expect(thread.costUsd).toBeGreaterThanOrEqual(request.costUsd);
});

Then("today's spending includes my message", async ({ page }) => {
  const { id } = await myMessage();
  const { body: request } = await getJson<Spend>(page, `/agents/spending/requests/${id}`);
  const { body } = await getJson<{ periods: Spend[] }>(page, '/agents/spending/periods?period=day&count=1');

  expect(body.periods).toHaveLength(1);
  expect(body.periods[0].costUsd).toBeGreaterThanOrEqual(request.costUsd);
});

// ---------------------------------------------------------------------------
// The Spending page
// ---------------------------------------------------------------------------

/** "$1,234.56" or "< $0.01" as dollars; "< $0.01" reads as a cent's fraction above zero. */
function dollars(text: string): number {
  if (text.includes('<')) return 0.001;
  return Number(text.replace(/[^0-9.]/g, ''));
}

/** The label the page gives an amount: cents, or "< $0.01" below a cent. */
function usdLabel(usd: number): string {
  if (usd > 0 && usd < 0.01) return '< $0.01';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(usd);
}

When('I follow the link to the spending page', async ({ page }) => {
  await page.getByTestId('activity-spending-link').click();
  await expect(page).toHaveURL(/\/spending$/);
});

Then("this month's spending is above zero", async ({ page }) => {
  // The turn's calls land as each returns, and the page reads them every minute, so reload until they show.
  await expect
    .poll(async () => {
      await page.reload();
      const tile = page.getByTestId('spending-this-month');
      await tile.waitFor();
      return dollars((await tile.textContent()) ?? '');
    }, { timeout: 20_000 })
    .toBeGreaterThan(0);
});

Then("today's bar in the spending chart is above zero", async ({ page }) => {
  const bars = page.getByTestId('spending-chart-bar');
  await expect(bars).toHaveCount(30);
  const label = (await bars.last().getAttribute('aria-label')) ?? '';
  expect(dollars(label.split(':')[1] ?? '')).toBeGreaterThan(0);
});

Then('my conversation is listed under top conversations', async ({ page }) => {
  const { threadId } = await myMessage();
  // The title is written beside the turn, so the page is read again until both agree.
  await expect
    .poll(async () => {
      const thread = await dbHelper.getPrisma().conversationThread.findUnique({ where: { id: threadId }, select: { title: true } });
      const row = page.getByTestId('spending-thread-row').first();
      await row.waitFor();
      const shown = (await row.textContent()) ?? '';
      if (shown.includes(thread?.title ?? 'Untitled conversation')) return true;
      await page.reload();
      return false;
    }, { timeout: 15_000 })
    .toBe(true);
});

When("I open my conversation's spending", async ({ page }) => {
  await page.getByTestId('spending-thread-row').first().click();
  await expect(page.getByTestId('spending-thread-sheet')).toBeVisible();
});

Then('my message is listed there with its cost', async ({ page }) => {
  const { id } = await myMessage();
  const { body: request } = await getJson<Spend>(page, `/agents/spending/requests/${id}`);
  const content = (await dbHelper.getPrisma().conversationMessage.findUnique({ where: { id }, select: { content: true } }))!.content;

  const row = page.getByTestId('spending-request').filter({ hasText: content.slice(0, 40) });
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-kind', 'message');
  await expect(row.locator('span.tabular-nums').last()).toHaveText(usdLabel(request.costUsd));
});

When("I expand my message's spending", async ({ page }) => {
  await page.locator('[data-testid="spending-request"][data-kind="message"]').first().click();
});

Then("its calls include the agent's replies", async ({ page }) => {
  await expect(page.getByTestId('spending-request-details')).toContainText('Agent replies');
});

Then('the sheet links to my conversation', async ({ page }) => {
  const { threadId } = await myMessage();
  await expect(page.getByTestId('spending-thread-sheet').getByRole('link', { name: 'Open conversation' })).toHaveAttribute(
    'href',
    `/chat/${threadId}`,
  );
});

// ---------------------------------------------------------------------------
// A channel conversation
// ---------------------------------------------------------------------------

/** A channel message as the runtime stores it: each person is a `<@id:name>` tag. */
const MENTIONING = '<@U0E2EANA01:Ana>: <@U0E2EPRISM1:Prismith> can you check the build';
/** The stored title, cut inside the second tag: `<@U0E2EANA01:Ana>: <@...`. */
const MENTIONING_TITLE = deriveThreadTitle(MENTIONING);
const BUCKET_MS = 15 * 60 * 1000;

// A channel's thread with stored history: the source is the database, the id is the channel's.
Given('a channel conversation whose message mentions people has spent on models', async () => {
  const db = dbHelper.getPrisma();
  const agentId = getCurrentAgentId();
  const threadId = await dbHelper.createThread(agentId, {
    title: MENTIONING_TITLE,
    externalThreadId: `1700000000.${Date.now()}`,
    externalChannelId: 'C_MOCK_E2E',
    messages: [{ role: 'USER', content: MENTIONING }],
  });
  const message = await db.conversationMessage.findFirstOrThrow({ where: { threadId }, select: { id: true } });
  const now = Date.now();
  await db.llmCall.create({
    data: {
      agentId,
      purpose: 'chat',
      model: 'claude-opus-5',
      threadId,
      requestId: message.id,
      inputTokens: 1000,
      outputTokens: 100,
      costMicroUsd: 25_000,
      costSource: 'catalog',
      createdAt: new Date(now),
      bucket: new Date(now - (now % BUCKET_MS)),
    },
  });
});

When('I open the spending page', async ({ page }) => {
  await new HomePage(page).goto('/spending');
});

Then('the channel conversation is listed under top conversations by the names in its title', async ({ page }) => {
  expect(MENTIONING_TITLE).toContain('<@');
  const row = page.getByTestId('spending-thread-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Ana:...');
  await expect(row).not.toContainText('<@');
});

When("I open the channel conversation's spending", async ({ page }) => {
  await page.getByTestId('spending-thread-row').click();
  await expect(page.getByTestId('spending-thread-sheet')).toBeVisible();
});

Then('its title and its message show the names in their mentions', async ({ page }) => {
  const sheet = page.getByTestId('spending-thread-sheet');
  await expect(sheet.locator('[data-slot="sheet-title"]')).toHaveText('Ana:...');
  const request = sheet.getByTestId('spending-request');
  await expect(request).toHaveCount(1);
  await expect(request).toContainText('Ana: Prismith can you check the build');
  await expect(request).not.toContainText('<@');
});

Then('the sheet has no link to open the conversation', async ({ page }) => {
  const sheet = page.getByTestId('spending-thread-sheet');
  // The sheet reads the conversation before it decides on the link.
  await expect(sheet.getByTestId('spending-request')).toHaveCount(1);
  await expect(sheet.getByRole('link', { name: 'Open conversation' })).toHaveCount(0);
});
