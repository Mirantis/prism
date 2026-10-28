/**
 * Heartbeat delivery step definitions (web)
 *
 * The setting is read from the Profile page and from `agent_workspaces`. A
 * heartbeat run is started through the runtime's own routes, and
 * `POST /agents/heartbeat/trigger` returns once the run has ended, so what the
 * run posted is in the database when the step returns.
 */

import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Given, When, Then } = createBdd();

/** Set when a scenario triggers the heartbeat; bounds the message queries. */
let heartbeatStartedAt: Date | null = null;

/** The heartbeat messages a client shows: the run's record of a post into web chat is an internal row. */
function shownHeartbeatMessages() {
  return dbHelper.getPrisma().conversationMessage.findMany({
    where: {
      role: 'AGENT',
      triggeredBy: 'HEARTBEAT',
      internalStep: false,
      createdAt: { gte: heartbeatStartedAt as Date },
      thread: { agentId: getCurrentAgentId() },
    },
  });
}

Then('the heartbeat may post to {string}', async ({ page }, label: string) => {
  await expect(page.locator('#heartbeat-deliver-to')).toContainText(label, { timeout: 15_000 });
});

When('I set the heartbeat to post to {string}', async ({ page }, label: string) => {
  await page.locator('#heartbeat-deliver-to').click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
});

Then('the stored heartbeat delivery is {string}', async ({}, deliverTo: string) => {
  await expect
    .poll(
      async () =>
        (
          await dbHelper.getPrisma().agentWorkspace.findUnique({
            where: { id: getCurrentAgentId() },
            select: { heartbeatDeliverTo: true },
          })
        )?.heartbeatDeliverTo,
      { timeout: 15_000 },
    )
    .toBe(deliverTo);
});

When('I reload the page', async ({ page }) => {
  await page.reload();
});

Given('the heartbeat checks are {string}', async ({ page }, checks: string) => {
  const res = await page.request.patch('/agents/documents/heartbeatMd', { data: { content: checks } });
  expect(res.ok()).toBe(true);
});

Given('the heartbeat may post to web chat only', async ({ page }) => {
  const res = await page.request.patch('/agents/heartbeat/delivery', { data: { deliverTo: 'chat' } });
  expect(res.ok()).toBe(true);
});

When('the heartbeat runs', async ({ page }) => {
  // One agent turn of a few model calls.
  test.setTimeout(240_000);
  const details = await page.request.get('/agents/details');
  expect(details.ok()).toBe(true);
  const { agent } = (await details.json()) as { agent: unknown };
  const started = await page.request.post('/agents/heartbeat/start', { data: { agent } });
  expect(started.ok()).toBe(true);

  heartbeatStartedAt = new Date();
  const run = await page.request.post('/agents/heartbeat/trigger', { timeout: 200_000 });
  expect(run.ok()).toBe(true);
});

Then('a heartbeat message reading exactly {string} is shown in the conversation', async ({}, text: string) => {
  const messages = await shownHeartbeatMessages();
  expect(messages.map((m) => m.content.trim())).toEqual([text]);
});

Then('no heartbeat message is shown in the conversation', async () => {
  expect(await shownHeartbeatMessages()).toEqual([]);
});
