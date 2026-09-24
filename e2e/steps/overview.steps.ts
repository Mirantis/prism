/**
 * Overview Step Definitions — the setup checklist, whose steps tick off from
 * the agent's own state.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';

const { Given, When, Then } = createBdd();

/** Tasks a scenario created through the API, removed at its end so no job outlives it. */
const createdTaskIds: string[] = [];

const step = (page: Page, key: string) =>
  page.getByTestId('setup-checklist').locator(`[data-testid="setup-step"][data-step="${key}"]`);

When('I navigate to the overview page', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
});

Then('the {string} setup step is done', async ({ page }, key: string) => {
  await expect(step(page, key)).toHaveAttribute('data-done', 'true');
});

Then('the {string} setup step is not done', async ({ page }, key: string) => {
  await expect(step(page, key)).not.toHaveAttribute('data-done', 'true');
});

Then('the {string} setup step is marked as next', async ({ page }, key: string) => {
  await expect(step(page, key).getByText('Next', { exact: true })).toBeVisible();
});

Given('a scheduled task {string} with the schedule {string}', async ({}, name: string, schedule: string) => {
  const res = await fetch(`${process.env.AGENT_RUNTIME_URL}/agents/cron-tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, schedule, instruction: 'Say hello.' }),
  });
  expect(res.ok).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTaskIds.push(task.id);
});

Then('the scheduled tasks created here are removed', async () => {
  for (const id of createdTaskIds.splice(0)) {
    const res = await fetch(`${process.env.AGENT_RUNTIME_URL}/agents/cron-tasks/${id}`, { method: 'DELETE' });
    expect(res.ok).toBe(true);
  }
});
