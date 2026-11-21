/**
 * Spending step definitions: the spending endpoints, read from the page the user
 * is signed in to, against the message the user sent.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import * as dbHelper from '../support/db-helper';

const { When, Then } = createBdd();

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
  expect(dollars((await row.locator('span.tabular-nums').last().textContent()) ?? '')).toBeCloseTo(request.costUsd, 2);
});

When("I expand my message's spending", async ({ page }) => {
  await page.locator('[data-testid="spending-request"][data-kind="message"]').first().click();
});

Then("its calls include the agent's replies", async ({ page }) => {
  await expect(page.getByTestId('spending-request-details')).toContainText('Agent replies');
});
