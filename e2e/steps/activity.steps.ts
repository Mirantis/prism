/**
 * Activity page step definitions.
 *
 * Assertions go against stored rows wherever they can: the page computes its
 * figures on read, so agreeing with the database is the claim worth proving.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { ActivityPage } from '../pages/activity.page';
import { HomePage } from '../pages/home.page';
import { DEFAULT_AGENT_ID, TEST_USER } from '../fixtures/test-data';

const { Given, When, Then } = createBdd();

function seededCalls(label: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    tool: 'shell_exec',
    input: JSON.stringify({ command: `${label} step ${i}` }),
    output: JSON.stringify({ stdout: `${label} out ${i}`, exitCode: 0 }),
    success: true,
    timestamp: new Date(Date.now() - (count - i) * 1000).toISOString(),
  }));
}

/** A thread to hang seeded rows off. */
async function seedThread(): Promise<string> {
  const db = dbHelper.getPrisma();
  const thread = await db.conversationThread.create({
    data: { agentId: DEFAULT_AGENT_ID, userId: TEST_USER.id },
  });
  return thread.id;
}

// ---------------------------------------------------------------------------
// Given
// ---------------------------------------------------------------------------

Given('the agent has 40 stored tool calls', async () => {
  const db = dbHelper.getPrisma();
  const threadId = await seedThread();

  // Uneven on purpose: one row holds 12 calls, so the 30-call page boundary
  // lands inside a row rather than neatly between two.
  const shapes = [12, 8, 8, 6, 6];
  for (const [n, count] of shapes.entries()) {
    await db.conversationMessage.create({
      data: {
        threadId,
        role: 'AGENT',
        content: `Seeded reply ${n}`,
        triggeredBy: 'USER_INPUT',
        toolCalls: seededCalls(`row-${n}`, count),
        createdAt: new Date(Date.now() - (shapes.length - n) * 60_000),
      },
    });
  }
});

Given('the agent has a stored tool call from a scheduled task', async () => {
  const db = dbHelper.getPrisma();
  const threadId = await seedThread();

  await db.conversationMessage.create({
    data: {
      threadId,
      role: 'AGENT',
      content: 'Scheduled task result',
      triggeredBy: 'CRON_TASK',
      toolCalls: seededCalls('cron', 1),
    },
  });
});

// ---------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------

When('I navigate to the activity page', async ({ page }) => {
  await new ActivityPage(page).navigate();
});

When('a chat turn that uses a tool completes', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.navigate();
  await homePage.typeMessage(
    'Use your shell to run `echo activity-e2e-marker`, then tell me what it printed.',
  );
  await homePage.sendMessage();
  await homePage.waitForStreamComplete();
});

When('I expand the newest tool call', async ({ page }) => {
  const activityPage = new ActivityPage(page);
  await activityPage.toolCalls.first().click();
});

When('I scroll to the end of the tool call list', async ({ page }) => {
  await new ActivityPage(page).scrollToLoadMore();
});

// ---------------------------------------------------------------------------
// Then
// ---------------------------------------------------------------------------

Then('the Activity nav item comes after Profile', async ({ page }) => {
  const labels = await page.locator('[data-slot="sidebar-menu-button"] span').allTextContents();
  const profile = labels.indexOf('Profile');
  const activity = labels.indexOf('Activity');
  expect(profile).toBeGreaterThan(-1);
  // Order, not adjacency: Computer sits between the two on a runtime that has a desktop
  // for it, and is left out where there is none.
  expect(activity).toBeGreaterThan(profile);
});

Then('the token totals are all zero', async ({ page }) => {
  const activityPage = new ActivityPage(page);
  await expect(activityPage.totalTokens).toHaveText('0');
  await expect(activityPage.inputTokens).toHaveText('0');
  await expect(activityPage.outputTokens).toHaveText('0');
});

Then('the cache hit rate is not reported', async ({ page }) => {
  // A dash, never a 0% — nothing in the window measured a cache.
  await expect(new ActivityPage(page).cacheHitRate).toHaveText('—');
});

Then('I should see the LLM usage section', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'LLM usage' })).toBeVisible();
});

Then('I should see the tool calls section', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Tool calls' })).toBeVisible();
});

Then('the tool call list says there are none yet', async ({ page }) => {
  await expect(new ActivityPage(page).emptyToolCalls).toBeVisible();
});

Then('the token totals are above zero', async ({ page }) => {
  const activityPage = new ActivityPage(page);
  await expect(activityPage.totalTokens).not.toHaveText('0', { timeout: 15_000 });
  await expect(activityPage.inputTokens).not.toHaveText('0');
  await expect(activityPage.outputTokens).not.toHaveText('0');
});

Then('the totals match the recorded model calls', async ({ page }) => {
  const db = dbHelper.getPrisma();

  // Rows land fire-and-forget as each call returns, so read both sides inside
  // the poll and retry until they agree. The cards abbreviate, so the
  // comparison is against the exact figure the runtime reports.
  await expect
    .poll(
      async () => {
        const recorded = await db.llmCall.aggregate({
          _sum: { inputTokens: true, outputTokens: true },
          _count: true,
        });
        const reported = await page.evaluate(async () => {
          const res = await fetch('/agents/activity/llm-usage?hours=24');
          return res.json() as Promise<{
            inputTokens: number;
            outputTokens: number;
            calls: number;
          }>;
        });

        return {
          someTokensRecorded: (recorded._sum.inputTokens ?? 0) > 0,
          inputTokens: reported.inputTokens === (recorded._sum.inputTokens ?? 0),
          outputTokens: reported.outputTokens === (recorded._sum.outputTokens ?? 0),
          calls: reported.calls === recorded._count,
        };
      },
      { timeout: 15_000 },
    )
    .toEqual({ someTokensRecorded: true, inputTokens: true, outputTokens: true, calls: true });
});

Then('the gate calls the turn made are counted too', async () => {
  const db = dbHelper.getPrisma();

  // A chat turn also pays for the feedback gate and the thread title, neither
  // of which publishes a message. Recording at the call is what catches them,
  // and the write is fire-and-forget, so poll for it.
  await expect
    .poll(
      () => db.llmCall.count({ where: { purpose: { in: ['feedback-gate', 'thread-title'] } } }),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
});

Then('the tool call list is not empty', async ({ page }) => {
  const activityPage = new ActivityPage(page);
  await expect(activityPage.toolCalls.first()).toBeVisible({ timeout: 15_000 });
});

Then('the newest stored tool call is listed first', async ({ page }) => {
  const reported = await page.evaluate(async () => {
    const res = await fetch('/agents/activity/tool-calls?limit=1');
    return res.json() as Promise<{ items: Array<{ tool: string }> }>;
  });

  const newest = reported.items[0];
  expect(newest).toBeDefined();

  // The row renders the tool name title-cased, e.g. shell_exec -> Shell Exec.
  const label = newest.tool
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  await expect(new ActivityPage(page).toolCalls.first()).toContainText(label);
});

Then('its parameters are shown', async ({ page }) => {
  // Title case: the card uppercases these labels through CSS, so the text in
  // the DOM is not what the screen shows.
  await expect(page.getByText('Input', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Output', { exact: true }).first()).toBeVisible();
});

Then('{int} tool calls are listed', async ({ page }, expected: number) => {
  await expect(new ActivityPage(page).toolCalls).toHaveCount(expected, { timeout: 15_000 });
});

Then('all {int} tool calls are listed', async ({ page }, expected: number) => {
  await expect(new ActivityPage(page).toolCalls).toHaveCount(expected, { timeout: 30_000 });
});

Then('no tool call is listed twice', async ({ page }) => {
  // Each row's text is unique because every seeded call names its own step.
  const texts = await new ActivityPage(page).toolCalls.allTextContents();
  expect(new Set(texts).size).toBe(texts.length);
});

Then('a tool call is labelled {word}', async ({ page }, label: string) => {
  await expect(page.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
});
