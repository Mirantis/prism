/**
 * Scheduled Tasks Step Definitions (web)
 *
 * Uses the /cron page: the New-task dialog with its schedule presets, and the
 * rows the created tasks render as.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { ScheduledTasksPage } from '../pages/scheduled-tasks.page';

const { When, Then } = createBdd();

When('I navigate to the scheduled tasks page', async ({ page }) => {
  await new ScheduledTasksPage(page).navigate();
});

When(
  'I create the task {string} with the {string} schedule',
  async ({ page }, name: string, preset: string) => {
    await new ScheduledTasksPage(page).createTaskFromPreset(name, preset, 'Post a short standup summary.');
  },
);

When('I delete the task {string}', async ({ page }, name: string) => {
  await new ScheduledTasksPage(page).deleteTask(name);
});

Then(
  'the task {string} is listed as {string} with the expression {string}',
  async ({ page }, name: string, described: string, expression: string) => {
    const row = new ScheduledTasksPage(page).taskRow(name);
    await expect(row.getByText(described, { exact: true })).toBeVisible();
    await expect(row.getByText(expression, { exact: true })).toBeVisible();
  },
);

Then('the task {string} is active', async ({ page }, name: string) => {
  await expect(new ScheduledTasksPage(page).taskRow(name).getByText('Active', { exact: true })).toBeVisible();
});

Then('no scheduled task is listed', async ({ page }) => {
  await expect(page.getByText('No scheduled tasks', { exact: true })).toBeVisible();
});
