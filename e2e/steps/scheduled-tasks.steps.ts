/**
 * Scheduled Tasks Step Definitions (web)
 *
 * Uses the /cron page: the New-task and Edit dialogs with their schedule
 * presets, and the rows the tasks render as. A chat edit is read from the
 * tool calls stored on the agent's messages.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { ScheduledTasksPage } from '../pages/scheduled-tasks.page';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

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

Then("the new task form reads schedules in the agent's time zone {string}", async ({ page }, zone: string) => {
  const tasks = new ScheduledTasksPage(page);
  await tasks.newTaskButton.click();
  await expect(tasks.dialog.getByTestId('schedule-help')).toContainText(`the agent's time zone, ${zone}`);
  await tasks.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(tasks.dialog).toBeHidden();
});

When(
  'I start the task {string} with the {string} schedule',
  async ({ page }, name: string, preset: string) => {
    await new ScheduledTasksPage(page).startTaskFromPreset(name, preset);
  },
);

When('I give the new task the instruction {string}', async ({ page }, instruction: string) => {
  await new ScheduledTasksPage(page).fillInstruction(instruction);
});

Then('the Schedule button is disabled', async ({ page }) => {
  await expect(new ScheduledTasksPage(page).scheduleButton).toBeDisabled();
});

Then('the Schedule button is enabled', async ({ page }) => {
  await expect(new ScheduledTasksPage(page).scheduleButton).toBeEnabled();
});

When(
  'I edit the task {string} to {string} with the {string} schedule and the instruction {string}',
  async ({ page }, name: string, newName: string, preset: string, instruction: string) => {
    const tasks = new ScheduledTasksPage(page);
    await tasks.openEdit(name);
    // The dialog opens on the task as it is stored.
    await expect(page.locator('#cron-name')).toHaveValue(name);
    await expect(page.locator('#cron-instruction')).toHaveValue('Post a short standup summary.');
    await tasks.saveEdit(newName, preset, instruction);
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

Then('the task {string} shows its next run', async ({ page }, name: string) => {
  // Reported by the runtime from the task's running schedule, and rendered as a relative time.
  await expect(new ScheduledTasksPage(page).taskRow(name).getByText(/^Next run in /)).toBeVisible();
});

Then('no scheduled task is listed', async ({ page }) => {
  await expect(page.getByText('No scheduled tasks', { exact: true })).toBeVisible();
});

Then('the task {string} has the instruction {string}', async ({ page }, name: string, instruction: string) => {
  await expect(new ScheduledTasksPage(page).taskRow(name).getByText(instruction, { exact: true })).toBeVisible();
});

Then('the task {string} is not listed', async ({ page }, name: string) => {
  await expect(new ScheduledTasksPage(page).taskRow(name)).toHaveCount(0);
});

Then('the agent changed the task with update_scheduled_task', async () => {
  // The list alone cannot tell an edit from a delete and a new task of the same name.
  const storedCalls = async () => {
    const rows = await dbHelper.getPrisma().conversationMessage.findMany({
      where: { role: 'AGENT', thread: { agentId: getCurrentAgentId() } },
      select: { toolCalls: true },
    });
    return rows.flatMap((row) =>
      Array.isArray(row.toolCalls) ? (row.toolCalls as { tool: string; success: boolean }[]) : [],
    );
  };
  await expect
    .poll(async () => (await storedCalls()).some((call) => call.tool === 'update_scheduled_task' && call.success), {
      timeout: 120_000,
    })
    .toBe(true);
  expect((await storedCalls()).map((call) => call.tool)).not.toContain('delete_scheduled_task');
});
